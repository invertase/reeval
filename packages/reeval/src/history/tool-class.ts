// What a tool call was for, at sync: reading what the environment declared or a skill the agent
// found (`context`),
// digging in installed packages (`dependency`), the web, running a check (`verify`), or the
// workspace. A heuristic over the call's tool name and target, documented as one. Shell
// commands are split into words first, so an exclusion such as `-not -path '*/node_modules/*'`
// isn't counted as a read of what it excludes.
import { BUILTIN_SKILL_DIRS } from '@reeval/agents/layouts'
import { SKILL_LOAD_TOOLS } from './tool-target.ts'

export type ToolClass = 'context' | 'dependency' | 'web' | 'verify' | 'workspace'

export const TOOL_CLASSES: ToolClass[] = ['context', 'dependency', 'web', 'verify', 'workspace']

/** What an attempt's environment declared, and the commands its checks ran. */
export type ClassContext = {
  /** Skill names its environment placed. */
  skills: string[]
  /** The skill directories agents read (`SKILL_DIRS`), where a skill counts whoever put it there. */
  skillDirs: readonly string[]
  /** Skills it had in those directories that its environment didn't place. */
  found?: readonly string[]
  /** Placed files (not the agent CLI's own state), as the record lists them: `~/…` or relative. */
  files: string[]
  /** MCP server names. */
  mcp: string[]
  /** The commands the eval's `c.exec` calls ran. */
  verify: string[]
}

const SHELL_TOOL = /shell|bash|terminal|command|exec/i
const WEB_TOOL = /web|fetch|browse|url/i
const DEPENDENCY =
  /(^|\/)(node_modules|site-packages|dist-packages|vendor|\.venv|\.cargo\/registry|go\/pkg\/mod)(\/|$)/
const VERIFY =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)|npx\s+(?:tsc|vitest|jest|eslint|biome)|tsc|vitest|jest|pytest|eslint|cargo\s+(?:test|build|check)|go\s+(?:test|build|vet))\b/

/** Words of a shell command, quotes removed; `;`, `|` and `&&` split words. */
export function shellWords(command: string): string[] {
  const words: string[] = []
  let word = ''
  let quote: string | null = null
  let started = false
  const flush = () => {
    if (started) words.push(word)
    word = ''
    started = false
  }
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else word += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) flush()
    else if (ch === ';' || ch === '|' || ch === '&') {
      flush()
      words.push(ch)
    } else {
      word += ch
      started = true
    }
  }
  flush()
  return words
}

/** A heredoc and its header line; the terminator may close a `bash -c "…"` script's quote. */
const HEREDOC =
  /^([^\n]*?)<<-?[ \t]*(['"]?)([\w.-]+)\2([^\n]*)\n[\s\S]*?(?:^[ \t]*\3[ \t]*["']?[ \t]*$|(?![\s\S]))/gm

/**
 * A command without the text its `cat` or `tee` heredocs write to a file: what a file says it
 * reads, runs or depends on isn't what the command does. A heredoc another program reads
 * (`python3 - <<EOF`, `cat <<EOF | sh`) stays.
 */
function withoutWrittenText(command: string): string {
  if (!command.includes('<<')) return command
  return command.replace(HEREDOC, (all, head: string, _q, _d, tail: string) => {
    const line = `${head}${tail}`
    return /\b(?:cat|tee)\b/.test(line) && /\btee\b|>/.test(line) && !line.includes('|')
      ? line
      : all
  })
}

/** A command's words, with a `bash -c '…'` (or `-lc`) script split into its own words. */
function commandWords(command: string): string[] {
  const words = shellWords(command)
  return words.flatMap((w, i) =>
    i > 0 && /^-[a-z]*c$/.test(words[i - 1] as string) && /\s/.test(w) ? commandWords(w) : [w],
  )
}

const EXCLUDING_FLAG = /^--(?:exclude|exclude-dir|ignore|ignore-dir)(?:=|$)/

/** The words of a command that name something it reads, without the ones it excludes. */
function readWords(words: string[]): string[] {
  const out: string[] = []
  let test = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string
    const prev = words[i - 1]
    if (w === '[' || w === '[[' || w === 'test') test = true
    else if (w === ']' || w === ']]' || w === ';' || w === '|' || w === '&') test = false
    // `[ -d x ]` asks whether x exists; it doesn't read it.
    if (test && /^-[defsrwx]$/.test(w)) {
      i++
      continue
    }
    if (EXCLUDING_FLAG.test(w)) {
      if (!w.includes('=')) i++
      continue
    }
    if (
      (w === '-path' || w === '-name' || w === '-ipath' || w === '-wholename') &&
      i + 1 < words.length
    ) {
      const pruned = words[i + 2] === '-prune'
      if (prev === '-not' || prev === '!' || pruned) {
        i++
        continue
      }
    }
    if ((w === '-g' || w === '--glob' || w === '--iglob') && words[i + 1]?.startsWith('!')) {
      i++
      continue
    }
    if (/^--i?glob=!/.test(w)) continue
    if (w === '-v' && i > 0) {
      i++
      continue
    }
    out.push(w)
  }
  return out
}

/** `/home/<user>/x` and `/root/x` as `~/x`; `./x` as `x`. */
const normalize = (p: string) =>
  p
    .replace(/^\/home\/[^/]+\//, '~/')
    .replace(/^\/root\//, '~/')
    .replace(/^\$HOME\//, '~/')
    .replace(/^\.\//, '')

const GLOB = /[*?[{]/

/** `*`, `**` and `?` as wildcards; every other character, `[` included, literally. */
function wildcards(glob: string): string {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
      } else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return re
}

/** A glob as a regex, with `{a,b}` alternatives. Words come from transcripts, so it never throws. */
function globRegex(glob: string): RegExp {
  let re = ''
  let from = 0
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] !== '{') continue
    const end = glob.indexOf('}', i)
    if (end < 0) break
    re += wildcards(glob.slice(from, i))
    re += `(?:${glob
      .slice(i + 1, end)
      .split(',')
      .map(wildcards)
      .join('|')})`
    from = end + 1
    i = end
  }
  return new RegExp(`^${re}${wildcards(glob.slice(from))}$`)
}

/** The declared files one word names: the file itself, one of a glob's matches, or a directory's. */
function filesOf(word: string, files: string[]): { files: string[]; dir: boolean } {
  const w = normalize(word).replace(/\/+$/, '')
  if (!w) return { files: [], dir: false }
  // A relative word may be relative to home (`.agents/skills/…`) or the workspace.
  const forms = (f: string) => (f.startsWith('~/') ? [f, f.slice(2)] : [f])
  const matches = (f: string, test: (form: string) => boolean) =>
    forms(f).some((form) => test(form) || (!w.startsWith('~/') && test(`~/${form}`)))
  if (GLOB.test(w)) {
    const re = globRegex(w)
    // A glob that starts with a wildcard searches the workspace, never home.
    const fromWorkspace = /^[*?[{]/.test(w)
    return {
      files: files.filter((f) =>
        fromWorkspace ? !f.startsWith('~/') && re.test(f) : matches(f, (form) => re.test(form)),
      ),
      dir: false,
    }
  }
  const exact = files.filter((f) => matches(f, (form) => form === w || form.endsWith(`/${w}`)))
  if (exact.length) return { files: exact, dir: false }
  const under = files.filter((f) => matches(f, (form) => form.startsWith(`${w}/`)))
  return { files: [], dir: under.length > 0 }
}

/** A dedicated load's name is the skill's, or `<plugin>:<name>` for a plugin's (Claude Code). */
const isSkill = (loaded: string, name: string) => loaded === name || loaded.endsWith(`:${name}`)

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `skills/<name>` as a whole directory name: `skills/foo/SKILL.md` and `cd skills/foo`, not `skills/foo-bar`. */
const skillDirs = new Map<string, RegExp>()
const underSkill = (text: string, name: string) => {
  if (!text.includes('skills/')) return false
  let re = skillDirs.get(name)
  if (!re) {
    re = new RegExp(`skills/${escaped(name)}(?![\\w.-])`)
    skillDirs.set(name, re)
  }
  return re.test(text)
}

/**
 * Which of `skills` one tool call used, from its tool and uncapped target (`targetText`): a
 * dedicated load (`SKILL_LOAD_TOOLS`) by the skill's name, or a target under `skills/<name>`,
 * where a shell command's words count and the ones it excludes or only tests don't. Every
 * harness's skill use is one of these: `toHaveCalledSkill`, `skill_reads` and the `context`
 * class all decide by it.
 */
export function skillsUsed(tool: string, target: string, skills: readonly string[]): string[] {
  if (SKILL_LOAD_TOOLS.has(tool)) return skills.filter((s) => isSkill(target, s))
  const words = SHELL_TOOL.test(tool)
    ? readWords(commandWords(withoutWrittenText(target)))
    : [target]
  return skills.filter((s) => words.some((w) => underSkill(w, s)))
}

/**
 * Where a used skill came from: `placed` by the environment's `skills` (or a plugin), in a
 * `skill-dir` some agent reads (a setup step, the workspace or a package manager put it there),
 * or a `SKILL.md` read `elsewhere`, such as a package cache.
 */
export type SkillSource = 'placed' | 'skill-dir' | 'elsewhere'

/** `<name>` and the rest of the path, for every `skills/<name>` in a path. */
const SKILL_SEGMENT = /(?:^|\/)skills\/([^/\s*?[{}]+)(\/[^\s]*)?/g

/** The skill directory a path's `skills/<name>` sits in ends with one of `dirs`. */
const inSkillDir = (prefix: string, dirs: readonly string[]) =>
  dirs.some((d) => prefix === d || prefix.endsWith(`/${d}`))

/** A non-shell tool that changes files rather than reading them. */
const EDIT_TOOL = /write|edit|patch|create|delete|remove|move|rename|replace/i
/** Shell commands whose arguments it creates, changes or removes. */
const CHANGING = new Set(['rm', 'rmdir', 'mkdir', 'touch', 'mv', 'cp', 'tee', 'ln', 'install'])
const SEPARATOR = new Set([';', '|', '&'])
const REDIRECT = /^\d*>>?$/

/**
 * A shell command's words, split into the ones it reads and the ones it writes: a redirect's
 * target, every argument of `rm`, `mkdir`, `touch`, `mv`, `cp`, `tee` and the like, and the
 * files of a `sed -i`.
 */
function shellAccess(words: string[]): { read: string[]; written: string[] } {
  const read: string[] = []
  const written: string[] = []
  let changing = false
  let start = true
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string
    if (SEPARATOR.has(w)) {
      changing = false
      start = true
      continue
    }
    if (REDIRECT.test(w)) {
      if (i + 1 < words.length) written.push(words[++i] as string)
      continue
    }
    const glued = /^\d*>>?(.+)$/.exec(w)
    if (glued) {
      written.push(glued[1] as string)
      continue
    }
    if (start) {
      if (/^\w+=/.test(w) || w === 'sudo' || w === 'env') continue
      start = false
      const name = w.replace(/^.*\//, '')
      changing = CHANGING.has(name) || (name === 'sed' && words.slice(i).some(isInPlace))
    }
    ;(changing ? written : read).push(w)
  }
  return { read, written }
}

const isInPlace = (w: string) => /^-[a-zA-Z]*i/.test(w) || w.startsWith('--in-place')

/** The words of one call that read files, and the ones that write them. */
function callAccess(tool: string, target: string): { read: string[]; written: string[] } {
  if (SHELL_TOOL.test(tool)) {
    return shellAccess(readWords(commandWords(withoutWrittenText(target))))
  }
  return EDIT_TOOL.test(tool) ? { read: [], written: [target] } : { read: [target], written: [] }
}

/**
 * The skills whose `SKILL.md` one call writes: a skill the agent authors is its own work, not a
 * skill it found.
 */
export function skillsWritten(tool: string, target: string): string[] {
  return callAccess(tool, target).written.flatMap((word) => {
    const m = /(?:^|\/)skills\/([^/\s*?[{}]+)\/SKILL\.md$/.exec(normalize(word))
    return m && !(m[1] as string).startsWith('.') ? [m[1] as string] : []
  })
}

/**
 * The skills one tool call used, by source: the placed ones as {@link skillsUsed} finds them,
 * then any other a dedicated load named, any `skills/<name>/SKILL.md` it read (in one of `dirs`,
 * each agent's skill directories, or elsewhere) and any file under one of `found`, the skills the
 * attempt's context had in those directories. A path under some other `skills/<name>` isn't a
 * skill: `skills/r0/contract-probe` is a directory of skills, not a skill named `r0`. Nor is a
 * file the call writes, or a skill an agent CLI ships with (`BUILTIN_SKILL_DIRS`).
 */
export function skillUses(
  tool: string,
  target: string,
  placed: readonly string[],
  dirs: readonly string[],
  found: readonly string[] = [],
): Array<{ skill: string; source: SkillSource }> {
  const uses = new Map<string, SkillSource>(
    skillsUsed(tool, target, placed).map((s) => [s, 'placed']),
  )
  const isPlaced = (name: string) => placed.some((s) => isSkill(name, s))
  if (SKILL_LOAD_TOOLS.has(tool)) {
    const name = target.trim()
    if (name && !GLOB.test(name) && !/\s/.test(name) && !isPlaced(name)) uses.set(name, 'skill-dir')
    return [...uses].map(([skill, source]) => ({ skill, source }))
  }
  for (const word of callAccess(tool, target).read) {
    const w = normalize(word)
    if (!w.includes('skills/')) continue
    for (const m of w.matchAll(SKILL_SEGMENT)) {
      const name = m[1] as string
      if (name.startsWith('.') || uses.has(name) || isPlaced(name)) continue
      const prefix = w.slice(0, (m.index ?? 0) + m[0].indexOf('skills/') + 'skills'.length)
      if (inSkillDir(prefix.replace(/^~\//, ''), BUILTIN_SKILL_DIRS)) continue
      const inDir = inSkillDir(prefix.replace(/^~\//, ''), dirs)
      if (m[2] === '/SKILL.md') uses.set(name, inDir ? 'skill-dir' : 'elsewhere')
      else if (inDir && m[2] && m[2] !== '/' && found.includes(name)) uses.set(name, 'skill-dir')
    }
  }
  return [...uses].map(([skill, source]) => ({ skill, source }))
}

/** A skill in an agent's skill directory, from a context path such as `.claude/skills/<name>/SKILL.md`. */
export function skillDirSkill(path: string, dirs: readonly string[]): string | undefined {
  const m = /^(.*)\/([^/]+)\/SKILL\.md$/.exec(path.replace(/^~\//, ''))
  if (!m || (m[2] as string).startsWith('.')) return undefined
  return inSkillDir(m[1] as string, dirs) ? m[2] : undefined
}

/** A tool call's class, and the declared files it read (for `skill_files`). */
export function classifyCall(
  tool: string,
  target: string,
  ctx: ClassContext,
): { class: ToolClass; files: string[] } {
  const used = skillUses(tool, target, ctx.skills, ctx.skillDirs, ctx.found).map((u) => u.skill)
  if (SKILL_LOAD_TOOLS.has(tool)) {
    if (!used.length) return { class: 'workspace', files: [] }
    return {
      class: 'context',
      files: ctx.files.filter((f) => used.some((s) => f.endsWith(`skills/${s}/SKILL.md`))),
    }
  }
  if (ctx.mcp.some((s) => tool.startsWith(`mcp__${s}__`) || tool.startsWith(`${s}__`))) {
    return { class: 'context', files: [] }
  }
  const shell = SHELL_TOOL.test(tool)
  if (shell) target = withoutWrittenText(target)
  const words = shell ? readWords(commandWords(target)) : [target]
  const files = new Set<string>()
  let context = used.length > 0
  for (const w of words) {
    const hit = filesOf(w, ctx.files)
    for (const f of hit.files) files.add(f)
    if (hit.files.length || hit.dir) context = true
  }
  if (context) return { class: 'context', files: [...files] }
  if (words.some((w) => DEPENDENCY.test(normalize(w))) || (shell && words.includes('--help'))) {
    return { class: 'dependency', files: [] }
  }
  if (!shell && WEB_TOOL.test(tool)) return { class: 'web', files: [] }
  if (shell && words.some((w) => w === 'curl' || w === 'wget') && /https?:\/\//.test(target)) {
    return { class: 'web', files: [] }
  }
  if (shell) {
    const command = target.trim()
    if (ctx.verify.some((v) => v.trim().length >= 4 && command.includes(v.trim()))) {
      return { class: 'verify', files: [] }
    }
    if (VERIFY.test(command)) return { class: 'verify', files: [] }
  }
  return { class: 'workspace', files: [] }
}
