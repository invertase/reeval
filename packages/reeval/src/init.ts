// `reeval init`: scaffolds a project with one real agent configured, an environment and an eval that
// uses it (or, with --bare, only the config and its essentials), then says whether Docker is ready.
// It plans every file first and writes nothing when one would overwrite a file that differs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { Flags } from './cli-spec.ts'
import { CONFIG_FILES } from './config.ts'
import { UsageError } from './errors.ts'
import { type AgentKind, agentFor } from './harness/agents.ts'
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
  { kind: 'fx', label: 'fx', factory: 'fx', model: 'anthropic/claude-sonnet-5' },
  { kind: 'grok-build', label: 'Grok Build', factory: 'grokBuild', model: 'grok-4.6' },
]

export type InitChoice = AgentKind

const descriptorOf = (h: { kind: AgentKind; model: string }) =>
  ({ kind: h.kind, model: h.model }) as AgentHarnessDescriptor
/** The key an offered agent's pinned model needs. */
const keyOf = (h: { kind: AgentKind; model: string }) => agentFor(descriptorOf(h)).credential
/** The cell id an offered agent runs as, e.g. `opencode:gemini-3.8-flash`. */
const cellOf = (h: { kind: AgentKind; model: string }) => harnessId(descriptorOf(h))

const CHOICES: InitChoice[] = INIT_HARNESSES.map((h) => h.kind)
const DEFAULT_CHOICE: InitChoice = 'cursor'
const GITIGNORE = ['.reeval/', '.env*']
const EVAL_FILE = 'evals/greet.eval.ts'
const ENVIRONMENTS_FILE = 'evals/environments.ts'

export type InitAction = {
  /** Relative to the project, with `/` on every platform. */
  path: string
  action: 'create' | 'update' | 'overwrite' | 'keep'
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
  // For c.judge, add a judge and its key, e.g. { model: 'google/gemini-3.8-flash' }
  // with GOOGLE_GENERATIVE_AI_API_KEY.
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

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

/** A file reeval owns: created when missing, kept when the same, overwritten only with `force`. */
function owned(
  dir: string,
  path: string,
  content: string,
  note: string,
  force: boolean,
  conflicts: string[],
): InitAction {
  const existing = read(join(dir, path))
  if (existing === undefined) return { path, action: 'create', note, content }
  if (existing === content)
    return { path, action: 'keep', note: 'already as reeval init writes it' }
  if (!force) conflicts.push(`${path} exists and differs`)
  return { path, action: 'overwrite', note, content }
}

/** The entries reeval needs (`.reeval/`, `.env*`) that a `.gitignore`'s text doesn't list. */
export function missingGitignoreEntries(text: string): string[] {
  const lines = new Set(text.split(/\r?\n/).map((l) => l.trim().replace(/^\//, '')))
  return GITIGNORE.filter((e) => !lines.has(e) && !lines.has(e.replace(/\/$/, '')))
}

function gitignore(dir: string): InitAction {
  const existing = read(join(dir, '.gitignore'))
  const missing = missingGitignoreEntries(existing ?? '')
  if (!missing.length) return { path: '.gitignore', action: 'keep', note: GITIGNORE.join(', ') }
  if (existing === undefined) {
    const entries = ['node_modules/', ...missing]
    return {
      path: '.gitignore',
      action: 'create',
      note: entries.join(', '),
      content: `node_modules/\n\n# reeval: scratch runs and debug data; local keys\n${missing.join('\n')}\n`,
    }
  }
  const lead = existing && !existing.endsWith('\n') ? '\n' : ''
  const block = `${existing ? `${lead}\n` : ''}# reeval: scratch runs and debug data; local keys\n${missing.join('\n')}\n`
  return {
    path: '.gitignore',
    action: 'update',
    note: missing.join(', '),
    content: `${existing}${block}`,
  }
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
  let manifest: Record<string, Record<string, string> | unknown>
  try {
    manifest = JSON.parse(existing)
  } catch (error) {
    throw new UsageError(`package.json isn't valid JSON: ${(error as Error).message}`)
  }
  const notes: string[] = []
  const scripts = { ...(manifest.scripts as Record<string, string> | undefined) }
  if (!scripts.eval) {
    scripts.eval = 'reeval run'
    manifest.scripts = scripts
    notes.push('script eval')
  }
  const deps = manifest.dependencies as Record<string, string> | undefined
  const devDeps = { ...(manifest.devDependencies as Record<string, string> | undefined) }
  if (!deps?.[pkg] && !devDeps[pkg]) {
    devDeps[pkg] = range
    manifest.devDependencies = devDeps
    notes.push(`devDependency ${pkg}`)
  }
  if (!notes.length) {
    return { path: 'package.json', action: 'keep', note: `has an eval script and ${pkg}` }
  }
  const indent = /^[ \t]+/m.exec(existing)?.[0] ?? 2
  return {
    path: 'package.json',
    action: 'update',
    note: notes.join(', '),
    content: `${JSON.stringify(manifest, null, indent)}\n`,
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
  if (other.length && !force) conflicts.push(`${other.join(', ')} exists already`)
  const h = harnessOf(choice)
  const actions = [
    owned(
      dir,
      'reeval.config.ts',
      configSource(pkg, choice),
      `harness ${cellOf(h)}; profiles pr, nightly`,
      force,
      conflicts,
    ),
    ...(bare
      ? []
      : [
          owned(
            dir,
            ENVIRONMENTS_FILE,
            environmentsSource(pkg),
            'environment greeter: a package.json and rules',
            force,
            conflicts,
          ),
          owned(dir, EVAL_FILE, evalSource(pkg), 'one eval, in greeter', force, conflicts),
        ]),
    gitignore(dir),
    packageJson(dir, pkg, version),
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
  const { defaultDeps, dockerReadiness } = await import('./doctor.ts')
  return dockerReadiness(defaultDeps(), next)
}

/** `reeval init [dir]`: plans the scaffold, refuses conflicts without `--force`, then writes it. */
export async function initCommand(flags: Flags, args: string[], io: InitIO): Promise<number> {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  const dir = resolve(io.cwd, args[0] ?? '.')
  let choice: InitChoice
  if (flags.harness !== undefined) {
    const named = flags.harness.toLowerCase() as InitChoice
    if (!CHOICES.includes(named)) {
      throw new UsageError(`--harness must be one of ${CHOICES.join(', ')} (got ${flags.harness})`)
    }
    choice = named
  } else if (flags.yes) choice = DEFAULT_CHOICE
  else if (io.input.isTTY) choice = await askHarness(io.input, io.output)
  else {
    throw new UsageError(
      'reeval init asks which agent to configure, and there is no terminal to ask in. Pass --harness <name> or --yes.',
    )
  }
  const plan = planInit({
    dir,
    choice,
    force: !!flags.force,
    pkg: manifest.name,
    version: manifest.version,
    bare: !!flags.bare,
  })
  const where = posix(relative(io.cwd, dir)) || '.'
  if (plan.conflicts.length) {
    throw new UsageError(
      `reeval init won't overwrite files in ${where}: ${plan.conflicts.join('; ')}. Nothing was written. Pass --force to overwrite them.`,
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
  const pm = packageManager(dir)
  const h = harnessOf(choice)
  const build = `${pm.exec} image build`
  const next: Array<[string, string]> = [
    ...(where === '.' ? [] : [[`cd ${where}`, ''] as [string, string]]),
    [pm.install, ''],
    [build, `bakes ${h.label} into its sandbox image (needs Docker)`],
    [
      `${pm.exec} run`,
      `${flags.bare ? 'the evals you write in evals/' : 'the eval'} on ${h.label}, with ${keyOf(h)} in .env.local`,
    ],
  ]
  const pad = Math.max(...next.map(([c]) => c.length))
  io.out(`Next:\n${next.map(([c, n]) => `  ${n ? `${c.padEnd(pad)}  ${n}` : c}`).join('\n')}`)
  // A problem here is advice for the next step, never a failed init.
  const docker = await dockerLine(build).catch(
    (error: Error) =>
      `Docker couldn't be checked (${error.message}); reeval doctor checks it again`,
  )
  io.out(docker)
  return 0
}
