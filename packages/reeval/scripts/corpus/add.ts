// Adds an entry to the record corpus, test/fixtures/records/<name>/: real recorded runs that every
// reader is tested against (test/corpus.test.ts), so a later change to what ES persists is checked
// against files that really have today's shape.
//
//   pnpm build && pnpm --filter @invertase/foobar corpus:add <name> [--note "why"]
//     records scripts/corpus/project (the fake harness: a compare, judges, a failure, an infra
//     error, todo and skipped evals, a budget-stopped run and a saved analysis) with this build
//
//   pnpm --filter @invertase/foobar corpus:add <name> --from <project> [<runId>…] [--note "why"]
//     copies recorded runs (every one, or those named), their artifacts and the evals they ran
//     from another project's history folder, e.g. runs on real harnesses
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
const RUN_FILE = /^\d{8}T\d{6}Z_[0-9a-z]+_[0-9a-z-]+_[0-9a-z]{4}\.json$/

/** The corpus's own config: enough for every reader, and nothing that needs a key or Docker. */
const config = (
  note: string,
  es: string,
  commit: string,
) => `import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { fakeAnalysis } from 'evalsuite/judge'
import { fakeSandbox } from 'evalsuite/sandbox'

// A record corpus entry (${note}), recorded by ES ${es} at ${commit}.
// Don't re-record it: test/corpus.test.ts reads it to prove this shape still loads.
export default defineConfig({
  harness: fakeHarness(),
  sandbox: fakeSandbox(),
  analysis: {
    model: fakeAnalysis({ output: () => ({ tldr: 'corpus', whatHappened: [], results: [], why: [], anomalies: [], actions: [], confidence: { overall: 'low', why: 'corpus' } }) }),
  },
})
`

/** Runs `es`; the recipe's runs fail some evals on purpose, so exit 1 is fine. */
function es(dir: string, args: string[]): void {
  const r = spawnSync(process.execPath, [join(PACKAGE_DIR, 'dist/cli.js'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ES_UI: 'plain', NO_COLOR: '1' },
  })
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`es ${args.join(' ')} exited ${r.status}\n${r.stdout}${r.stderr}`)
  }
}

const git = (dir: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=ES corpus', '-c', 'user.email=corpus@evalsuite.dev', ...args],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  ).trim()

/** Records the recipe project in a temp git repo and returns its directory. */
function recordRecipe(): string {
  const dir = mkdtempSync(join(tmpdir(), 'es-corpus-'))
  cpSync(RECIPE, dir, { recursive: true })
  mkdirSync(join(dir, 'node_modules'))
  symlinkSync(PACKAGE_DIR, join(dir, 'node_modules/evalsuite'), 'dir')
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n.es\n')
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'corpus recipe')
  es(dir, ['run', 'greet', 'skill', '--record'])
  const [first] = runsIn(dir)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'first run')
  es(dir, ['run', 'slow', '--profile', 'budget', '--concurrency', '1', '--record'])
  es(dir, ['analyze', first as string, '--save'])
  return dir
}

const runsIn = (project: string) =>
  readdirSync(join(project, HISTORY))
    .filter((n) => RUN_FILE.test(n))
    .map((n) => n.slice(0, -5))
    .sort()

function main(): number {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { from: { type: 'string' }, note: { type: 'string' } },
  })
  const [name, ...only] = positionals
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    process.stderr.write('usage: corpus:add <name> [--from <project> [<runId>…]] [--note "why"]\n')
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
    process.stderr.write('Build ES first: pnpm build\n')
    return 2
  }
  const project = values.from ? resolve(values.from) : recordRecipe()
  const history = join(project, HISTORY)
  const runs = runsIn(project).filter((r) => !only.length || only.includes(r))
  if (!runs.length) {
    process.stderr.write(
      `No recorded runs${only.length ? ` named ${only.join(', ')}` : ''} in ${history}\n`,
    )
    return 2
  }
  const version = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).version
  const commit = git(PACKAGE_DIR, 'rev-parse', '--short', 'HEAD')
  const note =
    values.note ?? (values.from ? `runs copied from ${values.from}` : 'the corpus recipe')
  mkdirSync(join(target, HISTORY), { recursive: true })
  writeFileSync(join(target, 'es.config.ts'), config(note, version, commit))
  const files = new Set<string>()
  for (const runId of runs) {
    cpSync(join(history, `${runId}.json`), join(target, HISTORY, `${runId}.json`))
    if (existsSync(join(history, runId))) {
      cpSync(join(history, runId), join(target, HISTORY, runId), { recursive: true })
    }
    const record = JSON.parse(readFileSync(join(history, `${runId}.json`), 'utf8'))
    for (const e of record.evals ?? []) files.add(e.file)
  }
  for (const file of files) {
    if (!existsSync(join(project, file))) continue
    mkdirSync(dirname(join(target, file)), { recursive: true })
    cpSync(join(project, file), join(target, file))
  }
  if (!values.from) rmSync(project, { recursive: true, force: true })
  process.stdout.write(
    `added ${relative(PACKAGE_DIR, target)}: ${runs.length} run${runs.length === 1 ? '' : 's'} (${runs.join(', ')})\nRun test/corpus.test.ts, then commit it.\n`,
  )
  return 0
}

process.exitCode = main()
