// Adds an entry to the record corpus, test/fixtures/records/<name>/: real recorded runs that every
// reader is tested against (test/corpus.test.ts), so a later change to what reeval persists is checked
// against files that really have today's shape.
//
//   pnpm build && pnpm --filter reeval corpus:add <name> [--note "why"]
//     records scripts/corpus/project (the fake harness: a compare with questions, a pooled evaluate.each, judges, a
//     failure, an infra error, todo and skipped evals, and a saved analysis) with this build, one run of
//     about 3,000 lines
//
//   pnpm --filter reeval corpus:add <name> --from <project> [--from <project>…] [<runId>…] [--note "why"]
//     copies runs (every one, or those named), their artifacts and the evals they ran from other
//     projects, e.g. runs on real harnesses: recorded runs from evals/.history, and runs never
//     recorded (the harness contract's) from .reeval/runs
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url))
const RECIPE = join(PACKAGE_DIR, 'scripts/corpus/project')
const CORPUS = join(PACKAGE_DIR, 'test/fixtures/records')
const HISTORY = 'evals/.history'
const SCRATCH = '.reeval/runs'
const RUN_FILE = /^\d{8}T\d{6}Z_[0-9a-z]+_[0-9a-z-]+_[0-9a-z]{4}\.json$/

/** The corpus's own config: enough for every reader, and nothing that needs a key or Docker. */
const config = (
  note: string,
  recordedBy: string,
) => `import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

// A record corpus entry (${note}), recorded by ${recordedBy}.
// Don't re-record it: test/corpus.test.ts reads it to prove this shape still loads.
export default defineConfig({
  harness: fakeHarness(),
  environment: defineEnvironment('fake', { sandbox: fakeSandbox() }),
  analysis: {
    model: fakeAnalysis({ output: () => ({ tldr: 'corpus', whatHappened: [], results: [], why: [], anomalies: [], actions: [], confidence: { overall: 'low', why: 'corpus' } }) }),
  },
})
`

/** Runs `reeval`; the recipe's runs fail some evals on purpose, so exit 1 is fine. */
function reeval(dir: string, args: string[]): void {
  const r = spawnSync(process.execPath, [join(PACKAGE_DIR, 'dist/cli.js'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, REEVAL_UI: 'plain', NO_COLOR: '1' },
  })
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`reeval ${args.join(' ')} exited ${r.status}\n${r.stdout}${r.stderr}`)
  }
}

const git = (dir: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=reeval corpus', '-c', 'user.email=corpus@reeval.dev', ...args],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  ).trim()

/** Records the recipe project in a temp git repo and returns its directory. */
function recordRecipe(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reeval-corpus-'))
  cpSync(RECIPE, dir, { recursive: true })
  mkdirSync(join(dir, 'node_modules'))
  symlinkSync(PACKAGE_DIR, join(dir, 'node_modules/reeval'), 'dir')
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n.reeval\n')
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'corpus recipe')
  reeval(dir, ['run', '--record'])
  const [first] = runsIn(dir)
  reeval(dir, ['analyze', first as string, '--save'])
  return dir
}

const runFiles = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((n) => RUN_FILE.test(n)) : []

const runsIn = (project: string) =>
  runFiles(join(project, HISTORY))
    .map((n) => n.slice(0, -5))
    .sort()

type Source = { project: string; dir: string; runId: string }

/** Each run in a project: recorded ones from its history, the rest from its scratch runs. */
function sourcesIn(project: string): Source[] {
  const found = new Map<string, Source>()
  for (const folder of [SCRATCH, HISTORY]) {
    const dir = join(project, folder)
    for (const n of runFiles(dir))
      found.set(n.slice(0, -5), { project, dir, runId: n.slice(0, -5) })
  }
  return [...found.values()]
}

function main(): number {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { from: { type: 'string', multiple: true }, note: { type: 'string' } },
  })
  const [name, ...only] = positionals
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    process.stderr.write('usage: corpus:add <name> [--from <project>… [<runId>…]] [--note "why"]\n')
    return 2
  }
  const target = join(CORPUS, name)
  if (existsSync(target)) {
    process.stderr.write(
      `${relative(PACKAGE_DIR, target)} exists; corpus entries are never re-recorded, pick another name\n`,
    )
    return 2
  }
  if (!existsSync(join(PACKAGE_DIR, 'dist/cli.js'))) {
    process.stderr.write('Build reeval first: pnpm build\n')
    return 2
  }
  const from = (values.from ?? []).map((p) => resolve(p))
  const projects = from.length ? from : [recordRecipe()]
  const sources = projects
    .flatMap(sourcesIn)
    .filter((s) => !only.length || only.includes(s.runId))
    .sort((a, b) => a.runId.localeCompare(b.runId))
  if (!sources.length) {
    process.stderr.write(
      `No runs${only.length ? ` named ${only.join(', ')}` : ''} in ${projects.map((p) => join(p, HISTORY)).join(', ')} or their ${SCRATCH}\n`,
    )
    return 2
  }
  const twice = sources.find((s, i) => sources[i - 1]?.runId === s.runId)
  if (twice) {
    process.stderr.write(`${twice.runId} is in more than one project\n`)
    return 2
  }
  const records = sources.map((s) =>
    JSON.parse(readFileSync(join(s.dir, `${s.runId}.json`), 'utf8')),
  )
  // A copied run names the reeval that wrote it but not its commit, so the note carries that.
  const recordedBy = from.length
    ? `reeval ${[...new Set(records.map((r) => r.stack?.reeval ?? 'unknown'))].join(', ')}`
    : `reeval ${JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).version} at ${git(PACKAGE_DIR, 'rev-parse', '--short', 'HEAD')}`
  const note =
    values.note ??
    (from.length ? `runs copied from ${values.from?.join(', ')}` : 'the corpus recipe')
  mkdirSync(join(target, HISTORY), { recursive: true })
  writeFileSync(join(target, 'reeval.config.ts'), config(note, recordedBy))
  const files = new Map<string, string>()
  for (const [i, { project, dir, runId }] of sources.entries()) {
    cpSync(join(dir, `${runId}.json`), join(target, HISTORY, `${runId}.json`))
    if (existsSync(join(dir, runId))) {
      cpSync(join(dir, runId), join(target, HISTORY, runId), { recursive: true })
    }
    for (const e of records[i].evals ?? []) files.set(e.file, join(project, e.file))
  }
  for (const [file, path] of files) {
    if (!existsSync(path)) continue
    mkdirSync(dirname(join(target, file)), { recursive: true })
    cpSync(path, join(target, file))
  }
  if (!from.length) rmSync(projects[0] as string, { recursive: true, force: true })
  const ids = sources.map((s) => s.runId)
  process.stdout.write(
    `added ${relative(PACKAGE_DIR, target)}: ${ids.length} run${ids.length === 1 ? '' : 's'} (${ids.join(', ')})\nRun test/corpus.test.ts, then commit it.\n`,
  )
  return 0
}

process.exitCode = main()
