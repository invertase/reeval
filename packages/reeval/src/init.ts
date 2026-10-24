// `reeval init`: scaffolds a project with one real agent configured, an environment and an eval that
// uses it (or, with --bare, only the config and its essentials), then says whether Docker is ready.
// It plans every file first. In a project that has a config already it stops before asking anything;
// otherwise it only adds: existing files are merged into or skipped, never overwritten.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { parseTsconfig } from 'get-tsconfig'
import type { Flags } from './cli-spec.ts'
import { CONFIG_FILES } from './config.ts'
import { UsageError } from './errors.ts'
import { type AgentKind, agentFor } from './harness/agents.ts'
import { RECOMMENDED_ANALYSIS_MODEL } from './judge/index.ts'
import { harnessId } from './options.ts'
import { PACKAGE_DIR } from './root.ts'
import type { AgentHarnessDescriptor } from './types.ts'

/** The agents `reeval init` offers, in the order it lists them, with the model it pins. */
export const INIT_HARNESSES: ReadonlyArray<{
  kind: AgentKind
  label: string
  factory: string
  model: string
}> = [
  { kind: 'cursor', label: 'Cursor', factory: 'cursor', model: 'composer-2.5' },
  { kind: 'claude-code', label: 'Claude Code', factory: 'claudeCode', model: 'claude-sonnet-5' },
  {
    kind: 'antigravity',
    label: 'Antigravity',
    factory: 'antigravity',
    model: 'gemini-3.8-flash-medium',
  },
  { kind: 'opencode', label: 'OpenCode', factory: 'opencode', model: 'google/gemini-3.8-flash' },
  { kind: 'goose', label: 'Goose', factory: 'goose', model: 'gemini-3.8-flash' },
  { kind: 'pi', label: 'pi', factory: 'pi', model: 'gemini-3.8-flash' },
  { kind: 'codex', label: 'Codex', factory: 'codex', model: 'gpt-5.6-luna' },
  { kind: 'fx', label: 'fx', factory: 'fx', model: 'gpt-5.5' },
  { kind: 'grok-build', label: 'Grok Build', factory: 'grokBuild', model: 'grok-4.6' },
]

export type InitChoice = AgentKind

const descriptorOf = (h: { kind: AgentKind; model: string }) =>
  ({ kind: h.kind, model: h.model }) as AgentHarnessDescriptor
/** The key an offered agent's pinned model needs. */
const keyOf = (h: { kind: AgentKind; model: string }) => agentFor(descriptorOf(h)).credential
/** The cell id an offered agent runs as, e.g. `opencode:gemini-3.8-flash`. */
const cellOf = (h: { kind: AgentKind; model: string }) => harnessId(descriptorOf(h))

/** The key that calls `analysis.model` directly. */
const ANALYSIS_KEY = 'GOOGLE_GENERATIVE_AI_API_KEY'

const CHOICES: InitChoice[] = INIT_HARNESSES.map((h) => h.kind)
const DEFAULT_CHOICE: InitChoice = 'cursor'
const GITIGNORE = ['.reeval/', '.env*']
const EVAL_FILE = 'evals/greet.eval.ts'
const ENVIRONMENTS_FILE = 'evals/environments.ts'
const SAME = 'already as reeval init writes it'
const YOURS = 'exists: left as it is'
/** How long init waits on `docker info`: a Docker Desktop still starting can hold it for minutes. */
const DOCKER_CHECK_MS = 10_000

export type InitAction = {
  /** Relative to the project, with `/` on every platform. */
  path: string
  action: 'create' | 'update' | 'overwrite' | 'skip'
  note: string
  content?: string
}

export type InitPlan = { dir: string; actions: InitAction[]; conflicts: string[] }

const posix = (path: string) => path.split(sep).join('/')

function harnessOf(choice: InitChoice) {
  const h = INIT_HARNESSES.find((h) => h.kind === choice)
  if (!h) throw new UsageError(`--harness must be one of ${CHOICES.join(', ')} (got ${choice})`)
  return h
}

export function configSource(pkg: string, choice: InitChoice): string {
  const h = harnessOf(choice)
  return `import { defineConfig } from '${pkg}'
import { ${h.factory} } from '${pkg}/harness'

export default defineConfig({
  include: ['evals/**/*.eval.ts'],
  harness: ${h.factory}({ model: '${h.model}' }), // needs ${keyOf(h)}
  timeout: '15m',
  // For c.judge, add a judge, e.g. judge: { model: '${RECOMMENDED_ANALYSIS_MODEL}' }.
  // Insights explain each eval after a run, with ${ANALYSIS_KEY};
  // insights: false turns them off.
  analysis: { model: '${RECOMMENDED_ANALYSIS_MODEL}' },
  defaultProfile: { ci: 'pr' },
  profiles: {
    // PR runs in CI: one attempt per cell, no variants.
    pr: { limit: { runs: 1, compare: false }, budget: { attempts: 20 } },
    // Thorough: three attempts per cell, recorded every time.
    nightly: {
      defaults: { runs: 3 },
      record: 'always',
      budget: { attempts: 80, duration: '2h' },
    },
  },
})
`
}

export function environmentsSource(pkg: string): string {
  return `import { defineEnvironment } from '${pkg}'

/** What every attempt of greet.eval.ts starts in, before the agent's first turn. */
export const greeter = defineEnvironment('greeter', {
  // Written into the workspace.
  files: { 'package.json': '{ "type": "module" }\\n' },
  // The project's rules: AGENTS.md, or CLAUDE.md for Claude Code.
  rules: 'Write ES modules with named exports. Add no dependencies.\\n',
})
`
}

export function evalSource(pkg: string): string {
  return `import { evaluate, expect } from '${pkg}'
import { greeter } from './environments.ts'

const greetsAda = \`node -e "import('./greet.js').then((m) =>
  process.exit(m.greet('Ada') === 'Hello, Ada!' ? 0 : 1))"\`

evaluate('creates greet.js', { environment: greeter }, async (c) => {
  const turn = await c.send(
    'Create greet.js, an ES module exporting greet(name) that returns ' +
      '"Hello, <name>!". No dependencies.',
  )

  await expect(turn).toHaveFile('greet.js', /greet/)
  await expect(c.exec(greetsAda)).toSucceed()
})
`
}

const TSCONFIG = `{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "strict": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["*.ts", "evals"]
}
`

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n')

/** The config reeval writes: created when missing, skipped when the same, replaced only with `force`. */
function config(
  dir: string,
  content: string,
  note: string,
  force: boolean,
  conflicts: string[],
): InitAction {
  const path = 'reeval.config.ts'
  const existing = read(join(dir, path))
  if (existing === undefined) return { path, action: 'create', note, content }
  if (existing === content) return { path, action: 'skip', note: SAME }
  if (!force) conflicts.push(`${path} exists and isn't the one reeval init writes`)
  return { path, action: 'overwrite', note, content }
}

/** A file init adds only when it's missing: one that exists is the project's own. */
function added(dir: string, path: string, content: string, note: string): InitAction {
  const existing = read(join(dir, path))
  if (existing === undefined) return { path, action: 'create', note, content }
  return { path, action: 'skip', note: existing === content ? SAME : YOURS }
}

/** The entries reeval needs (`.reeval/`, `.env*`) that a `.gitignore`'s text doesn't list. */
export function missingGitignoreEntries(text: string): string[] {
  const lines = new Set(text.split(/\r?\n/).map((l) => l.trim().replace(/^\//, '')))
  return GITIGNORE.filter((e) => !lines.has(e) && !lines.has(e.replace(/\/$/, '')))
}

function gitignore(dir: string): InitAction {
  const existing = read(join(dir, '.gitignore'))
  const missing = missingGitignoreEntries(existing ?? '')
  if (!missing.length)
    return { path: '.gitignore', action: 'skip', note: `lists ${GITIGNORE.join(', ')}` }
  if (existing === undefined) {
    const entries = ['node_modules/', ...missing]
    return {
      path: '.gitignore',
      action: 'create',
      note: entries.join(', '),
      content: `node_modules/\n\n# reeval: scratch runs and debug data; local keys\n${missing.join('\n')}\n`,
    }
  }
  const eol = eolOf(existing)
  const lead = existing && !existing.endsWith('\n') ? eol : ''
  const block = [
    ...(existing ? [`${lead}`] : []),
    '# reeval: scratch runs and debug data; local keys',
    ...missing,
    '',
  ].join(eol)
  return {
    path: '.gitignore',
    action: 'update',
    note: missing.join(', '),
    content: `${existing}${block}`,
  }
}

const skipString = (t: string, i: number) => {
  for (i++; i < t.length && t[i] !== '"'; i++) if (t[i] === '\\') i++
  return i + 1
}
const skipSpace = (t: string, i: number) => {
  while (i < t.length && /\s/.test(t[i] ?? '')) i++
  return i
}
function skipValue(t: string, i: number): number {
  if (t[i] === '"') return skipString(t, i)
  if (t[i] !== '{' && t[i] !== '[') {
    while (i < t.length && !/[\s,}\]]/.test(t[i] ?? '')) i++
    return i
  }
  for (let depth = 0; i < t.length; i++) {
    if (t[i] === '"') i = skipString(t, i) - 1
    else if (t[i] === '{' || t[i] === '[') depth++
    else if ((t[i] === '}' || t[i] === ']') && --depth === 0) return i + 1
  }
  return i
}

/** The members of the JSON object opening at `open` (valid JSON): each key, and where its value ends. */
function membersOf(t: string, open: number) {
  const members: Array<{ key: string; start: number; value: number; end: number }> = []
  let i = skipSpace(t, open + 1)
  while (t[i] === '"') {
    const keyEnd = skipString(t, i)
    const value = skipSpace(t, skipSpace(t, keyEnd) + 1)
    const end = skipValue(t, value)
    members.push({ key: JSON.parse(t.slice(i, keyEnd)), start: i, value, end })
    i = skipSpace(t, end)
    if (t[i] === ',') i = skipSpace(t, i + 1)
  }
  return members
}

/**
 * `text` with `"key": value` added as the last member of the object opening at `open`, laid out as
 * that object's members are: the same line breaks and indentation, so the rest of the file is
 * untouched. `value(lead)` gets the whitespace that starts a member, for nesting an object.
 */
function addMember(t: string, open: number, key: string, value: (lead: string) => string) {
  const members = membersOf(t, open)
  const last = members.at(-1)
  if (!last) {
    const close = skipSpace(t, open + 1)
    return `${t.slice(0, open)}{ ${JSON.stringify(key)}: ${value(' ')} }${t.slice(close + 1)}`
  }
  const before = members.at(-2)
  const from = before ? t.indexOf(',', before.end) + 1 : open + 1
  const lead = t.slice(from, last.start)
  return `${t.slice(0, last.end)},${lead}${JSON.stringify(key)}: ${value(lead)}${t.slice(last.end)}`
}

/** `{ "name": "value" }` nested one level below members that start with `lead`. */
const nested = (name: string, v: string) => (lead: string) => {
  const entry = `${JSON.stringify(name)}: ${JSON.stringify(v)}`
  if (!lead.includes('\n')) return `{ ${entry} }`
  const unit = lead.slice(lead.lastIndexOf('\n') + 1)
  return `{${lead}${unit}${entry}${lead}}`
}

/** `package.json` with `section.name` set to `v`, every other byte as it was. */
function withEntry(text: string, section: string, name: string, v: string): string {
  const root = skipSpace(text, 0)
  const top = membersOf(text, root).find((m) => m.key === section)
  if (top && text[top.value] === '{') {
    return addMember(text, top.value, name, () => JSON.stringify(v))
  }
  return addMember(text, root, section, nested(name, v))
}

function packageJson(dir: string, pkg: string, version: string): InitAction {
  const path = join(dir, 'package.json')
  const existing = read(path)
  const range = `^${version}`
  if (existing === undefined) {
    const name = posix(resolve(dir)).split('/').pop() ?? 'evals'
    const manifest = {
      name: name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'evals',
      private: true,
      type: 'module',
      scripts: { eval: 'reeval run' },
      devDependencies: { [pkg]: range },
    }
    return {
      path: 'package.json',
      action: 'create',
      note: `script eval, devDependency ${pkg}`,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    }
  }
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(existing)
  } catch (error) {
    throw new UsageError(`package.json isn't valid JSON: ${(error as Error).message}`)
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new UsageError("package.json isn't a JSON object")
  }
  const scripts = manifest.scripts as Record<string, string> | undefined
  const has = (section: string) =>
    !!(manifest[section] as Record<string, string> | undefined)?.[pkg]
  const hasPkg = has('dependencies') || has('devDependencies')
  let content = existing
  const added: string[] = []
  const kept: string[] = []
  if (!scripts?.eval) {
    content = withEntry(content, 'scripts', 'eval', 'reeval run')
    added.push('script eval')
  } else if (scripts.eval !== 'reeval run') {
    kept.push(`its eval script (${scripts.eval})`)
  }
  if (!hasPkg) {
    content = withEntry(content, 'devDependencies', pkg, range)
    added.push(`devDependency ${pkg}`)
  }
  const keptNote = kept.length ? `; kept ${kept.join(', ')}` : ''
  if (!added.length) {
    return {
      path: 'package.json',
      action: 'skip',
      note: kept.length ? `has ${pkg}; kept ${kept.join(', ')}` : `has an eval script and ${pkg}`,
    }
  }
  return { path: 'package.json', action: 'update', note: `${added.join(', ')}${keptNote}`, content }
}

/** A `tsconfig.json` editors and `tsc` read the evals' `.ts` imports with; an existing one is left. */
function tsconfig(dir: string): InitAction {
  const path = join(dir, 'tsconfig.json')
  const existing = read(path)
  if (existing === undefined) {
    return {
      path: 'tsconfig.json',
      action: 'create',
      note: "for editors and tsc: the evals' .ts imports, no emit",
      content: TSCONFIG,
    }
  }
  if (existing === TSCONFIG) return { path: 'tsconfig.json', action: 'skip', note: SAME }
  let options: Record<string, unknown> | undefined
  try {
    options = parseTsconfig(path).compilerOptions as Record<string, unknown> | undefined
  } catch {
    return { path: 'tsconfig.json', action: 'skip', note: YOURS }
  }
  const ok = options?.allowImportingTsExtensions || options?.rewriteRelativeImportExtensions
  return {
    path: 'tsconfig.json',
    action: 'skip',
    note: ok
      ? YOURS
      : `${YOURS}; for the eval's .ts import, add "allowImportingTsExtensions": true (with noEmit)`,
  }
}

/** Why init stops in `dir` before asking anything: reeval is set up there already. */
function setUpAlready(
  dir: string,
  options: { pkg: string; force: boolean; choice?: InitChoice },
): { choice?: InitChoice; refusal?: string } {
  const other = CONFIG_FILES.filter((f) => f !== 'reeval.config.ts' && existsSync(join(dir, f)))
  if (other.length) {
    return {
      refusal: `${other.join(' and ')} ${other.length > 1 ? 'are' : 'is'} its config. Nothing was written. To start again with reeval.config.ts, delete ${other.length > 1 ? 'them' : 'it'} first.`,
    }
  }
  const existing = read(join(dir, 'reeval.config.ts'))
  if (existing === undefined) return {}
  const same = CHOICES.find((c) => configSource(options.pkg, c) === existing)
  if (same && (options.choice ?? same) === same) return { choice: same }
  if (options.force) return {}
  return {
    refusal:
      "reeval.config.ts exists and isn't the one reeval init writes. Nothing was written. Pass --force to replace it; init never overwrites another file.",
  }
}

/** Everything `reeval init` would do in `dir`, without writing. */
export function planInit(options: {
  dir: string
  choice: InitChoice
  force: boolean
  pkg: string
  version: string
  /** Only the config and its essentials: no environment or eval. */
  bare?: boolean
}): InitPlan {
  const { dir, choice, force, pkg, version, bare } = options
  const conflicts: string[] = []
  const other = CONFIG_FILES.filter((f) => f !== 'reeval.config.ts' && existsSync(join(dir, f)))
  if (other.length) conflicts.push(`${other.join(', ')} exists already`)
  const h = harnessOf(choice)
  const environments = added(
    dir,
    ENVIRONMENTS_FILE,
    environmentsSource(pkg),
    'environment greeter: a package.json and rules',
  )
  const ownEnvironments =
    environments.note === YOURS ? (read(join(dir, ENVIRONMENTS_FILE)) ?? '') : undefined
  const evalAction: InitAction =
    ownEnvironments !== undefined &&
    !/\bexport\s+(const|let|var)\s+greeter\b/.test(ownEnvironments) &&
    !existsSync(join(dir, EVAL_FILE))
      ? {
          path: EVAL_FILE,
          action: 'skip',
          note: `imports greeter, which your ${ENVIRONMENTS_FILE} doesn't export`,
        }
      : added(dir, EVAL_FILE, evalSource(pkg), 'one eval, in greeter')
  const actions = [
    config(
      dir,
      configSource(pkg, choice),
      `harness ${cellOf(h)}; insights ${RECOMMENDED_ANALYSIS_MODEL}; profiles pr, nightly`,
      force,
      conflicts,
    ),
    ...(bare ? [] : [environments, evalAction]),
    gitignore(dir),
    packageJson(dir, pkg, version),
    ...(bare ? [] : [tsconfig(dir)]),
  ]
  return { dir, actions, conflicts }
}

/** Asks which agent to configure, by number or name; the empty answer takes the default. */
export async function askHarness(input: Readable, output: Writable): Promise<InitChoice> {
  const lines = [
    'Which agent should reeval.config.ts run?',
    ...INIT_HARNESSES.map((h, i) => `  ${i + 1}) ${h.label.padEnd(12)} ${cellOf(h)}, ${keyOf(h)}`),
  ]
  output.write(`${lines.join('\n')}\n`)
  const rl = createInterface({ input, terminal: false })
  const answers = rl[Symbol.asyncIterator]()
  try {
    for (;;) {
      output.write(`Agent [1]: `)
      const next = await answers.next()
      if (next.done)
        throw new UsageError('reeval init got no answer. Pass --harness <name> or --yes.')
      const answer = String(next.value).trim().toLowerCase()
      if (!answer) return DEFAULT_CHOICE
      const byNumber = CHOICES[Number(answer) - 1]
      if (/^\d+$/.test(answer) && byNumber) return byNumber
      const byName = CHOICES.find(
        (c) => c === answer || harnessOf(c).label.toLowerCase() === answer,
      )
      if (byName) return byName
      output.write(`Answer 1 to ${CHOICES.length}, or one of ${CHOICES.join(', ')}.\n`)
    }
  } finally {
    rl.close()
  }
}

function packageManager(dir: string): { install: string; exec: string } {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, 'pnpm-lock.yaml')))
      return { install: 'pnpm install', exec: 'pnpm reeval' }
    if (existsSync(join(d, 'yarn.lock'))) return { install: 'yarn', exec: 'yarn reeval' }
    if (existsSync(join(d, 'bun.lock'))) return { install: 'bun install', exec: 'bunx reeval' }
    if (existsSync(join(d, 'package-lock.json')) || dirname(d) === d) break
  }
  return { install: 'npm install', exec: 'npx reeval' }
}

export type InitIO = {
  out: (line: string) => void
  input: Readable & { isTTY?: boolean }
  output: Writable
  cwd: string
}

const dockerLine = async (next: string) => {
  try {
    const { defaultDeps, dockerReadiness } = await import('./doctor.ts')
    return await dockerReadiness(defaultDeps(), next, AbortSignal.timeout(DOCKER_CHECK_MS))
  } catch (error) {
    return (error as Error).name === 'TimeoutError'
      ? `Docker didn't answer within ${DOCKER_CHECK_MS / 1000}s: wait for it to start, or check it with reeval doctor, then run ${next}`
      : `Docker couldn't be checked (${(error as Error).message}): reeval doctor checks it again, then run ${next}`
  }
}

/** `reeval init [dir]`: plans the scaffold, stops where reeval is set up already, then writes it. */
export async function initCommand(flags: Flags, args: string[], io: InitIO): Promise<number> {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  const dir = resolve(io.cwd, args[0] ?? '.')
  const where = posix(relative(io.cwd, dir)) || '.'
  const force = !!flags.force
  let named: InitChoice | undefined
  if (flags.harness !== undefined) {
    named = flags.harness.toLowerCase() as InitChoice
    if (!CHOICES.includes(named)) {
      throw new UsageError(`--harness must be one of ${CHOICES.join(', ')} (got ${flags.harness})`)
    }
  }
  const setUp = setUpAlready(dir, { pkg: manifest.name, force, choice: named })
  if (setUp.refusal) {
    throw new UsageError(`reeval is already set up in ${where}: ${setUp.refusal}`)
  }
  let choice: InitChoice
  if (named) choice = named
  else if (setUp.choice) choice = setUp.choice
  else if (flags.yes) choice = DEFAULT_CHOICE
  else if (io.input.isTTY) choice = await askHarness(io.input, io.output)
  else {
    throw new UsageError(
      'reeval init asks which agent to configure, and there is no terminal to ask in. Pass --harness <name> or --yes.',
    )
  }
  const plan = planInit({
    dir,
    choice,
    force,
    pkg: manifest.name,
    version: manifest.version,
    bare: !!flags.bare,
  })
  if (plan.conflicts.length) {
    throw new UsageError(
      `reeval is already set up in ${where}: ${plan.conflicts.join('; ')}. Nothing was written.`,
    )
  }
  const dry = !!flags['dry-run']
  io.out(`reeval init · ${where}${dry ? ' (nothing written: --dry-run)' : ''}`)
  const width = Math.max(...plan.actions.map((a) => a.path.length))
  for (const a of plan.actions) {
    io.out(`  ${a.action.padEnd(9)} ${a.path.padEnd(width)}  ${a.note}`)
  }
  if (!dry) {
    for (const a of plan.actions) {
      if (a.content === undefined) continue
      const path = join(dir, ...a.path.split('/'))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, a.content)
    }
  }
  io.out(
    `Insights: ${RECOMMENDED_ANALYSIS_MODEL} explains each eval after a run, with ${ANALYSIS_KEY}; analysis.insights: false or --no-insights turns them off`,
  )
  const pm = packageManager(dir)
  const h = harnessOf(choice)
  const build = `${pm.exec} image build`
  const example = plan.actions.find((a) => a.path === EVAL_FILE)
  const evals = !example
    ? 'the evals you write in evals/'
    : example.action === 'create' || example.note === SAME
      ? 'the eval'
      : 'the evals in evals/'
  const next: Array<[string, string]> = [
    ...(where === '.' ? [] : [[`cd ${where}`, ''] as [string, string]]),
    [pm.install, ''],
    [build, `bakes ${h.label} into its sandbox image (needs Docker)`],
    [`${pm.exec} run`, `${evals} on ${h.label}, with ${keyOf(h)} in .env.local`],
  ]
  const pad = Math.max(...next.map(([c]) => c.length))
  io.out(`Next:\n${next.map(([c, n]) => `  ${n ? `${c.padEnd(pad)}  ${n}` : c}`).join('\n')}`)
  // A problem here is advice for the next step, never a failed init.
  io.out(await dockerLine(build))
  return 0
}
