// Code coverage across every process the tests start. NODE_V8_COVERAGE is inherited, so the test
// runner, each spawned `es` CLI, its Vitest workers and the egress gateway (in the CLI and the
// workers) all write V8 coverage into one directory, and c8 merges it, mapping dist/ back to src/
// through the build's source maps. Report-only: there's no threshold.
//
//   node scripts/coverage.mjs run [cmd...]   cmd (default: every package's tests) with coverage on, then report
//   node scripts/coverage.mjs prune <dir>    shrink a raw directory to one file of this repo's code
//   node scripts/coverage.mjs report [dir…]  copy raw dirs into coverage/raw and write the reports
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
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mergeProcessCovs } from '@bcoe/v8-coverage'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'coverage')
const raw = join(out, 'raw')
const reports = join(out, 'report')
const repo = pathToFileURL(join(root, 'packages')).href
/** The packages whose src/ is reported; studio-web's app runs in a browser, which isn't measured. */
const PACKAGES = ['evalsuite', 'sandbox-docker']
/** The build copies sandbox-docker's dist here without its maps; the files are identical. */
const vendored = `${repo}/evalsuite/dist/vendor/sandbox-docker/dist/`
const sandboxDist = `${repo}/sandbox-docker/dist/`
/** Where the executed code comes from: built dist/ (mapped to src/) and src/ run directly by tests. */
const ours = new RegExp(`^${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+/(dist|src)/`)

const [command, ...args] = process.argv.slice(2)
if (command === 'run') process.exit(run(args))
else if (command === 'prune') prune(resolve(args[0] ?? raw))
else if (command === 'report') report(args.map((a) => resolve(a)))
else {
  console.error('usage: node scripts/coverage.mjs run [cmd...] | prune <dir> | report [dir...]')
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

/**
 * Keeps only this repo's packages (not node_modules, tests or temp projects), points vendored
 * sandbox-docker code at its own dist/ (which has maps), and merges every process into one
 * file. Hundreds of raw files of a few MB each become one of a few MB.
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
    const remap = (url) =>
      url.startsWith(vendored) ? sandboxDist + url.slice(vendored.length) : url
    const result = data.result
      .filter((s) => ours.test(s.url) && !s.url.includes('/node_modules/'))
      .map((s) => ({ ...s, url: remap(s.url) }))
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
      const built = join(root, 'packages', pkg, 'dist', name.replace(/\.ts$/, '.js'))
      if (!existsSync(built)) continue
      const code = readFileSync(built, 'utf8')
        .replace(/\/\/# sourceMappingURL=.*$/m, '')
        .trim()
      if (code === 'export {};') files.push(`packages/${pkg}/src/${name}`)
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
    }
    for (const k of ['lines', 'branches']) {
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
    'Every process the tests start (the test runner, `es`, its Vitest workers and the egress',
    'gateway), merged, mapped to `src/`. Report-only: no threshold. Code inside Docker',
    'containers, the browser (studio-web) and the packed-install test is not counted.',
    '',
    '| | Lines | Branches | Functions |',
    '|---|---|---|---|',
    `| **total** | ${pct(total.lines)} | ${pct(total.branches)} | ${pct(total.functions)} |`,
    ...[...packages].map(
      ([name, p]) => `| ${name} | ${pct(withPct(p.lines))} | ${pct(withPct(p.branches))} | |`,
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
