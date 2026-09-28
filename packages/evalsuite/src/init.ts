// `es init`: scaffolds a project that passes on the fake agent, with one real agent configured.
// It plans every file first and writes nothing when one would overwrite a file that differs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { Flags } from './cli-spec.ts'
import { CONFIG_FILES } from './config.ts'
import { UsageError } from './errors.ts'
import { type AgentKind, agentFor } from './harness/agents.ts'
import { PACKAGE_DIR } from './root.ts'
import type { AgentHarnessDescriptor } from './types.ts'

/** The agents `es init` offers, in the order it lists them, with the model it pins. */
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
  { kind: 'codex', label: 'Codex', factory: 'codex', model: 'gpt-5.4-mini' },
]

export type InitChoice = AgentKind | 'none'

/** The key an offered agent's pinned model needs. */
const keyOf = (h: { kind: AgentKind; model: string }) =>
  agentFor({ kind: h.kind, model: h.model } as AgentHarnessDescriptor).credential

const CHOICES: InitChoice[] = [...INIT_HARNESSES.map((h) => h.kind), 'none']
const DEFAULT_CHOICE: InitChoice = 'cursor'
const GITIGNORE = ['.es/', '.env*']
const EVAL_FILE = 'evals/greet.es.ts'

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
  return INIT_HARNESSES.find((h) => h.kind === choice)
}

export function configSource(pkg: string, choice: InitChoice): string {
  const real = harnessOf(choice)
  const harnessImports = real ? `${real.factory}, fakeHarness` : 'fakeHarness'
  const sandboxImports = real ? 'docker, fakeSandbox' : 'fakeSandbox'
  const fakeAgent = `// The fake agent writes the file ${EVAL_FILE} asks for: no keys, Docker or network.
const fakeAgent = fakeHarness({
  files: { 'greet.js': 'export const greet = (name) => \`Hello, \${name}!\`\\n' },
  text: 'I created greet.js exporting greet(name).',
})
`
  const profiles = `    // PR runs in CI: one attempt per cell, no variants.
    pr: { limit: { runs: 1, compare: false }, budget: { attempts: 20 } },
    // Thorough: three attempts per cell, recorded every time.
    nightly: {
      defaults: { runs: 3 },
      record: 'always',
      budget: { attempts: 80, duration: '2h' },
    },`
  const body = real
    ? `  harness: ${real.factory}({ model: '${real.model}' }), // needs ${keyOf(real)}
  sandbox: docker(),
  timeout: '15m',
  // For t.judge, add a judge and its key, e.g. { model: 'google/gemini-3.8-flash' }
  // with GOOGLE_GENERATIVE_AI_API_KEY.
  defaultProfile: { ci: 'pr' },
  profiles: {
    // es run --profile fake: the evals on the fake agent.
    fake: { defaults: { harness: fakeAgent, sandbox: fakeSandbox() } },
${profiles}
  },`
    : `  harness: fakeAgent,
  sandbox: fakeSandbox(),
  defaultProfile: { ci: 'pr' },
  profiles: {
${profiles}
  },`
  return `import { defineConfig } from '${pkg}'
import { ${harnessImports} } from '${pkg}/harness'
import { ${sandboxImports} } from '${pkg}/sandbox'

${fakeAgent}
export default defineConfig({
  include: ['evals/**/*.es.ts'],
${body}
})
`
}

export function evalSource(pkg: string): string {
  return `import { evaluate, expect } from '${pkg}'

const greetsAda = \`node -e "import('./greet.js').then((m) =>
  process.exit(m.greet('Ada') === 'Hello, Ada!' ? 0 : 1))"\`

evaluate('creates greet.js', async (t) => {
  const turn = await t.send(
    'Create greet.js, an ES module exporting greet(name) that returns ' +
      '"Hello, <name>!". No dependencies.',
  )

  await expect(turn).toHaveFile('greet.js', /greet/)
  await expect(t.exec(greetsAda)).toSucceed()
})
`
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

/** A file ES owns: created when missing, kept when the same, overwritten only with `force`. */
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
  if (existing === content) return { path, action: 'keep', note: 'already as es init writes it' }
  if (!force) conflicts.push(`${path} exists and differs`)
  return { path, action: 'overwrite', note, content }
}

/** The entries ES needs (`.es/`, `.env*`) that a `.gitignore`'s text doesn't list. */
export function missingGitignoreEntries(text: string): string[] {
  const lines = new Set(text.split(/\r?\n/).map((l) => l.trim().replace(/^\//, '')))
  return GITIGNORE.filter((e) => !lines.has(e) && !lines.has(e.replace(/\/$/, '')))
}

function gitignore(dir: string): InitAction {
  const existing = read(join(dir, '.gitignore'))
  const missing = missingGitignoreEntries(existing ?? '')
  if (!missing.length) return { path: '.gitignore', action: 'keep', note: GITIGNORE.join(', ') }
  const lead = existing && !existing.endsWith('\n') ? '\n' : ''
  const block = `${existing ? `${lead}\n` : ''}# ES: scratch runs and debug data; local keys\n${missing.join('\n')}\n`
  return {
    path: '.gitignore',
    action: existing === undefined ? 'create' : 'update',
    note: missing.join(', '),
    content: `${existing ?? ''}${block}`,
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
      scripts: { eval: 'es run' },
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
    scripts.eval = 'es run'
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

/** Everything `es init` would do in `dir`, without writing. */
export function planInit(options: {
  dir: string
  choice: InitChoice
  force: boolean
  pkg: string
  version: string
}): InitPlan {
  const { dir, choice, force, pkg, version } = options
  const conflicts: string[] = []
  const other = CONFIG_FILES.filter((f) => f !== 'es.config.ts' && existsSync(join(dir, f)))
  if (other.length && !force) conflicts.push(`${other.join(', ')} exists already`)
  const real = harnessOf(choice)
  const actions = [
    owned(
      dir,
      'es.config.ts',
      configSource(pkg, choice),
      real
        ? `harness ${real.kind}:${real.model}; profiles fake, pr, nightly`
        : 'the fake agent; profiles pr, nightly',
      force,
      conflicts,
    ),
    owned(dir, EVAL_FILE, evalSource(pkg), 'one eval, passes on the fake agent', force, conflicts),
    gitignore(dir),
    packageJson(dir, pkg, version),
  ]
  return { dir, actions, conflicts }
}

/** Asks which agent to configure, by number or name; the empty answer takes the default. */
export async function askHarness(input: Readable, output: Writable): Promise<InitChoice> {
  const lines = [
    'Which agent should es.config.ts run? The fake profile needs no keys or Docker.',
    ...INIT_HARNESSES.map(
      (h, i) => `  ${i + 1}) ${h.label.padEnd(12)} ${h.kind}:${h.model}, ${keyOf(h)}`,
    ),
    `  ${CHOICES.length}) None         the fake agent only`,
  ]
  output.write(`${lines.join('\n')}\n`)
  const rl = createInterface({ input, terminal: false })
  const answers = rl[Symbol.asyncIterator]()
  try {
    for (;;) {
      output.write(`Agent [1]: `)
      const next = await answers.next()
      if (next.done) throw new UsageError('es init got no answer. Pass --harness <name> or --yes.')
      const answer = String(next.value).trim().toLowerCase()
      if (!answer) return DEFAULT_CHOICE
      const byNumber = CHOICES[Number(answer) - 1]
      if (/^\d+$/.test(answer) && byNumber) return byNumber
      const byName = CHOICES.find(
        (c) => c === answer || harnessOf(c)?.label.toLowerCase() === answer,
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
    if (existsSync(join(d, 'pnpm-lock.yaml'))) return { install: 'pnpm install', exec: 'pnpm es' }
    if (existsSync(join(d, 'yarn.lock'))) return { install: 'yarn', exec: 'yarn es' }
    if (existsSync(join(d, 'bun.lock'))) return { install: 'bun install', exec: 'bunx es' }
    if (existsSync(join(d, 'package-lock.json')) || dirname(d) === d) break
  }
  return { install: 'npm install', exec: 'npx es' }
}

export type InitIO = {
  out: (line: string) => void
  input: Readable & { isTTY?: boolean }
  output: Writable
  cwd: string
}

/** `es init [dir]`: plans the scaffold, refuses conflicts without `--force`, then writes it. */
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
      'es init asks which agent to configure, and there is no terminal to ask in. Pass --harness <name> or --yes.',
    )
  }
  const plan = planInit({
    dir,
    choice,
    force: !!flags.force,
    pkg: manifest.name,
    version: manifest.version,
  })
  const where = posix(relative(io.cwd, dir)) || '.'
  if (plan.conflicts.length) {
    throw new UsageError(
      `es init won't overwrite files in ${where}: ${plan.conflicts.join('; ')}. Nothing was written. Pass --force to overwrite them.`,
    )
  }
  const dry = !!flags['dry-run']
  io.out(`es init · ${where}${dry ? ' (nothing written: --dry-run)' : ''}`)
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
  const real = harnessOf(choice)
  const next: Array<[string, string]> = [
    ...(where === '.' ? [] : [[`cd ${where}`, ''] as [string, string]]),
    [pm.install, ''],
    [
      `${pm.exec} run${real ? ' --profile fake' : ''}`,
      'passes now: the fake agent, no keys or Docker',
    ],
    ...(real
      ? ([
          [`${pm.exec} image build`, `bakes ${real.label} into its sandbox image (needs Docker)`],
          [`${pm.exec} run`, `on ${real.label}, with ${keyOf(real)} in .env.local`],
        ] as Array<[string, string]>)
      : []),
  ]
  const pad = Math.max(...next.map(([c]) => c.length))
  io.out(`Next:\n${next.map(([c, n]) => `  ${n ? `${c.padEnd(pad)}  ${n}` : c}`).join('\n')}`)
  return 0
}
