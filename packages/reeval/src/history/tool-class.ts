// What a tool call was for, at sync: reading what the environment declared (`context`),
// digging in installed packages (`dependency`), the web, running a check (`verify`), or the
// workspace. A heuristic over the call's tool name and target, documented as one. Shell
// commands are split into words first, so an exclusion such as `-not -path '*/node_modules/*'`
// isn't counted as a read of what it excludes.
import { SKILL_LOAD_TOOLS } from './tool-target.ts'

export type ToolClass = 'context' | 'dependency' | 'web' | 'verify' | 'workspace'

export const TOOL_CLASSES: ToolClass[] = ['context', 'dependency', 'web', 'verify', 'workspace']

/** What an attempt's environment declared, and the commands its checks ran. */
export type ClassContext = {
  /** Skill names its environment placed. */
  skills: string[]
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
const normalise = (p: string) =>
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
  const w = normalise(word).replace(/\/+$/, '')
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

/** A tool call's class, and the declared files it read (for `skill_files`). */
export function classifyCall(
  tool: string,
  target: string,
  ctx: ClassContext,
): { class: ToolClass; files: string[] } {
  if (SKILL_LOAD_TOOLS.has(tool)) {
    if (!ctx.skills.includes(target)) return { class: 'workspace', files: [] }
    return {
      class: 'context',
      files: ctx.files.filter((f) => f.endsWith(`skills/${target}/SKILL.md`)),
    }
  }
  if (ctx.mcp.some((s) => tool.startsWith(`mcp__${s}__`) || tool.startsWith(`${s}__`))) {
    return { class: 'context', files: [] }
  }
  const shell = SHELL_TOOL.test(tool)
  const words = shell ? readWords(commandWords(target)) : [target]
  const files = new Set<string>()
  let context = false
  for (const w of words) {
    const hit = filesOf(w, ctx.files)
    for (const f of hit.files) files.add(f)
    if (hit.files.length || hit.dir) context = true
    if (
      ctx.skills.some(
        (s) => normalise(w).includes(`skills/${s}/`) || normalise(w).endsWith(`skills/${s}`),
      )
    ) {
      context = true
    }
  }
  if (context) return { class: 'context', files: [...files] }
  if (words.some((w) => DEPENDENCY.test(normalise(w))) || (shell && words.includes('--help'))) {
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
