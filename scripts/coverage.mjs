// Code coverage across every process the tests start. NODE_V8_COVERAGE is inherited, so the test
// runner, each spawned `reeval` CLI, its workers and the egress gateway (in the CLI and the
// workers) all write V8 coverage into one directory, and c8 merges it, mapping dist/ back to src/
// through the build's source maps. The bundled reeval maps its inlined @reeval/*
// code back to each package's own src/. Report-only: there's no threshold.
//
//   node scripts/coverage.mjs run [cmd...]   cmd (default: every package's tests) with coverage on, then report
//   node scripts/coverage.mjs prune <dir>    shrink a raw directory to one file of this repo's code
//   node scripts/coverage.mjs report [dir…]  copy raw dirs into coverage/raw and write the reports
//   node scripts/coverage.mjs engine         the engine's tests, failing below 100% of ENGINE's
//                                            lines, branches and functions (CI's `engine coverage` job)
//
// Reports, in coverage/report/: index.html, lcov.info, coverage-summary.json and summary.md (the
// Markdown the CI job summary shows).
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mergeProcessCovs } from '@bcoe/v8-coverage'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'coverage')
const raw = join(out, 'raw')
const reports = join(out, 'report')
const repo = pathToFileURL(join(root, 'packages')).href
/** The packages whose src/ is reported; studio-web's app runs in a browser, which isn't measured. */
const PACKAGES = readdirSync(join(root, 'packages')).filter(
  (p) => p !== 'studio-web' && existsSync(join(root, 'packages', p, 'src')),
)
/** Where the executed code comes from: built dist/ (mapped to src/) and src/ run directly by tests. */
const ours = new RegExp(`^${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+/(dist|src)/`)

/**
 * The engine's own code, held to 100% of lines, branches and functions by its tests alone. A line the
 * tests can't reach takes a `c8 ignore` comment that says why.
 */
const ENGINE = [
  'budget',
  'collector',
  'errors',
  'expect',
  'files',
  'loader',
  'node',
  'pool',
  'protocol',
  'run',
  'runtime',
  'worker',
  'worker-entry',
].map((name) => `packages/reeval/src/engine/${name}.ts`)
/** The tests that cover it, run from packages/reeval: its unit tests, and the CLI end to end. */
const ENGINE_TESTS = [
  'test/engine-collector.test.ts',
  'test/engine-errors.test.ts',
  'test/engine-expect.test.ts',
  'test/engine-loader.test.ts',
  'test/engine-node.test.ts',
  'test/engine-pool.test.ts',
  'test/engine-run.test.ts',
  'test/engine-runtime.test.ts',
  'test/engine-worker.test.ts',
  'test/engine.test.ts',
]

const [command, ...args] = process.argv.slice(2)
if (command === 'run') process.exit(run(args))
else if (command === 'engine') process.exit(engine())
else if (command === 'prune') prune(resolve(args[0] ?? raw))
else if (command === 'report') report(args.map((a) => resolve(a)))
else {
  console.error(
    'usage: node scripts/coverage.mjs run [cmd...] | prune <dir> | report [dir...] | engine',
  )
  process.exit(2)
}

function run(cmd) {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(raw, { recursive: true })
  const [bin, ...rest] = cmd.length ? cmd : ['pnpm', '-r', '--filter', './packages/*', 'test']
  const tests = spawnSync(bin, rest, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_V8_COVERAGE: raw },
  })
  report([])
  if (tests.status !== 0) console.error(`\ncoverage: the tests failed (exit ${tests.status})`)
  return tests.status ?? 1
}

function engine() {
  const dir = join(out, 'engine')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'raw'), { recursive: true })
  const tests = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-timeout=600000',
      '--experimental-strip-types',
      '--no-warnings',
      ...ENGINE_TESTS,
    ],
    {
      cwd: join(root, 'packages/reeval'),
      stdio: 'inherit',
      env: { ...process.env, NODE_V8_COVERAGE: join(dir, 'raw') },
    },
  )
  if (tests.status !== 0) {
    console.error(`\nengine coverage: the tests failed (exit ${tests.status})`)
    return tests.status ?? 1
  }
  const c8 = spawnSync(
    'pnpm',
    [
      'exec',
      'c8',
      'report',
      '--temp-directory',
      join(dir, 'raw'),
      '--reports-dir',
      join(dir, 'report'),
      '--reporter=text',
      '--reporter=json-summary',
      '--exclude-after-remap',
      '--all',
      '--src=packages/reeval/src/engine',
      ...ENGINE.map((file) => `--include=${file}`),
      '--check-coverage',
      '--lines=100',
      '--branches=100',
      '--functions=100',
      '--per-file',
    ],
    { cwd: root, stdio: 'inherit' },
  )
  return c8.status ?? 1
}

/**
 * Keeps only this repo's packages (not node_modules, tests or temp projects) and merges every
 * process into one file. Hundreds of raw files of a few MB each become one of a few MB.
 */
function prune(dir) {
  const processes = []
  const maps = {}
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  for (const name of files) {
    const file = join(dir, name)
    let data
    try {
      data = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue // a process killed mid-write
    } finally {
      rmSync(file)
    }
    const result = data.result.filter((s) => ours.test(s.url) && !s.url.includes('/node_modules/'))
    if (result.length === 0) continue
    processes.push({ result })
    for (const [url, map] of Object.entries(data['source-map-cache'] ?? {}))
      if (result.some((s) => s.url === url)) maps[url] = map
  }
  if (processes.length === 0)
    return console.log(`coverage: nothing in ${relative(root, dir) || dir}`)
  const merged = { ...mergeProcessCovs(processes), 'source-map-cache': maps }
  writeFileSync(join(dir, `merged-${process.pid}-${Date.now()}.json`), JSON.stringify(merged))
  console.log(`coverage: merged ${processes.length} processes in ${relative(root, dir) || dir}`)
}

function report(dirs) {
  mkdirSync(raw, { recursive: true })
  for (const [i, dir] of dirs.entries())
    for (const name of readdirSync(dir))
      if (name.endsWith('.json')) cpSync(join(dir, name), join(raw, `${i}-${name}`))
  prune(raw)
  rmSync(reports, { recursive: true, force: true })
  const c8 = spawnSync(
    'pnpm',
    [
      'exec',
      'c8',
      'report',
      '--temp-directory',
      raw,
      '--reports-dir',
      reports,
      '--reporter=text',
      '--reporter=html',
      '--reporter=lcovonly',
      '--reporter=json-summary',
      '--exclude-after-remap',
      ...PACKAGES.map((p) => `--include=packages/${p}/src/**`),
      // Every src file counts, loaded or not; studio-web's app runs in the browser, not here.
      '--all',
      ...PACKAGES.map((p) => `--src=packages/${p}/src`),
      ...typeOnly().map((file) => `--exclude=${file}`),
    ],
    { cwd: root, stdio: 'inherit' },
  )
  if (c8.status !== 0) process.exit(c8.status ?? 1)
  const summary = join(reports, 'coverage-summary.json')
  writeFileSync(join(reports, 'summary.md'), markdown(JSON.parse(readFileSync(summary, 'utf8'))))
  console.log(`coverage: ${relative(root, reports)}/index.html, lcov.info and summary.md`)
}

/** Sources that compile to an empty module (types only): `--all` would count every line as missed. */
function typeOnly() {
  const files = []
  for (const pkg of PACKAGES) {
    const src = join(root, 'packages', pkg, 'src')
    for (const name of readdirSync(src, { recursive: true })) {
      if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue
      const code = stripTypeScriptTypes(readFileSync(join(src, name), 'utf8'))
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
        .replace(/export\s*\{\s*\};?/g, '')
        .trim()
      if (code === '') files.push(`packages/${pkg}/src/${name}`)
    }
  }
  return files
}

/** Totals, per package, and the weakest files by lines, for the job summary. */
function markdown(summary) {
  const pct = (m) => `${m.pct.toFixed(1)}% (${m.covered}/${m.total})`
  const { total, ...files } = summary
  const rows = Object.entries(files).map(([path, m]) => [relative(root, path), m])
  const packages = new Map()
  for (const [path, m] of rows) {
    const name = path.split('/')[1]
    const p = packages.get(name) ?? {
      lines: { total: 0, covered: 0 },
      branches: { total: 0, covered: 0 },
      functions: { total: 0, covered: 0 },
    }
    for (const k of ['lines', 'branches', 'functions']) {
      p[k].total += m[k].total
      p[k].covered += m[k].covered
    }
    packages.set(name, p)
  }
  const withPct = (m) => ({ ...m, pct: m.total ? (100 * m.covered) / m.total : 100 })
  const weakest = rows
    .filter(([, m]) => m.lines.total >= 20)
    .sort(([, a], [, b]) => a.lines.pct - b.lines.pct)
    .slice(0, 15)
  return [
    '## Code coverage',
    '',
    'Every process the tests start (the test runner, `reeval`, its workers and the egress',
    'gateway), merged, mapped to `src/`. Report-only: no threshold. Code inside Docker',
    'containers, the browser (studio-web) and the packed-install test is not counted.',
    '',
    '| | Lines | Branches | Functions |',
    '|---|---|---|---|',
    `| **total** | ${pct(total.lines)} | ${pct(total.branches)} | ${pct(total.functions)} |`,
    ...[...packages].map(
      ([name, p]) =>
        `| ${name} | ${pct(withPct(p.lines))} | ${pct(withPct(p.branches))} | ${pct(withPct(p.functions))} |`,
    ),
    '',
    '<details><summary>Weakest files (by lines, 20 lines or more)</summary>',
    '',
    '| File | Lines | Branches |',
    '|---|---|---|',
    ...weakest.map(([path, m]) => `| \`${path}\` | ${pct(m.lines)} | ${pct(m.branches)} |`),
    '',
    '</details>',
    '',
  ].join('\n')
}
