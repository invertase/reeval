// The side-by-side comparison of ES's engine with the Vitest engine it replaces
// (packages/evalsuite/test/support/differential.ts). Every `es` the suites run is captured,
// normalised, and compared by test file and call.
//
//   node --experimental-strip-types scripts/differential.mjs record <es|vitest> <dir>   run the suites on that engine into <dir>
//   node scripts/differential.mjs compare <expected> <actual> [--vitest]
//                                                   fail on any difference not in INTENDED;
//                                                   --vitest for a live Vitest run (below)
//
// test/differential/vitest/ holds the Vitest engine's captures: the replay the new engine is held
// to once Vitest is gone. `record vitest` then `compare` against it shows they're still current.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { renormalise } from '../packages/evalsuite/test/support/differential.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = join(root, 'packages/evalsuite')

/**
 * Every test file that runs `es` through runCli, on the fake sandbox; not `es doctor`'s, which
 * reports the host (Node, npm, Docker), not what the engine does.
 */
const SUITES = readdirSync(join(pkg, 'test'))
  .filter((f) => f.endsWith('.test.ts'))
  .filter(
    (f) =>
      !/^(docker|docker-antigravity|studio|pack|contract|e2e-real|real-tier|doctor)\.test\.ts$/.test(
        f,
      ),
  )
  .filter((f) => !f.startsWith('engine-'))
  .map((f) => `test/${f}`)

/**
 * Differences the new engine makes on purpose, by test file and a pattern on the capture's key,
 * with the part of the capture that may differ and why.
 */
const INTENDED = [
  {
    file: 'engine.test.ts.jsonl',
    key: /^worker-(killed|oom) run/,
    fields: ['live', 'summary', 'record'],
    why: "Vitest left a dead worker's attempts without a result (skipped); ES fails them, naming the file and signal.",
  },
  {
    file: 'engine.test.ts.jsonl',
    key: /^bad-eval-file run/,
    fields: ['stderr'],
    why: "A syntax error is reported in Babel's words (jiti) with a code frame, not Oxc's (Vite).",
  },
  {
    file: 'engine.test.ts.jsonl',
    key: /^(bad-tsconfig|tsconfig-json) run/,
    fields: ['stderr'],
    why: "A broken tsconfig is reported without Vite's `Transform failed with 1 error: [TSCONFIG_ERROR]` prefix, and invalid JSON in Node's words.",
  },
]

/** An attempt's progress line, which the Vitest engine could drop (see `compare`). */
const PROGRESS = /\] {2}\+<t> /

const [command, ...args] = process.argv.slice(2)
if (command === 'record') process.exit(record(args[0], resolve(args[1])))
else if (command === 'compare')
  process.exit(compare(resolve(args[0]), resolve(args[1]), args.includes('--vitest')))
else {
  console.error(
    'usage: node scripts/differential.mjs record <es|vitest> <dir> | compare <expected> <actual>',
  )
  process.exit(2)
}

function record(engine, dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const env = { ...process.env, ES_DIFFERENTIAL_DIR: dir, ES_FIXTURE_TIERS: 'fake' }
  if (engine === 'vitest') env.ES_ENGINE = 'vitest'
  else delete env.ES_ENGINE
  const tests = spawnSync(
    process.execPath,
    ['--test', '--test-timeout=600000', '--experimental-strip-types', '--no-warnings', ...SUITES],
    { cwd: pkg, env, stdio: ['ignore', 'ignore', 'inherit'] },
  )
  // A test may fail on the other engine (it asserts the new behaviour); its captures still count.
  console.log(`differential: recorded ${engine} into ${dir} (tests exited ${tests.status})`)
  return 0
}

function load(dir) {
  const files = new Map()
  for (const name of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []) {
    const byKey = new Map()
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean)) {
      const capture = renormalise(JSON.parse(line))
      byKey.set(capture.key, [...(byKey.get(capture.key) ?? []), capture])
    }
    files.set(name, byKey)
  }
  return files
}

/**
 * The Vitest engine sent progress over an async RPC, so an attempt's line that landed after its
 * result was sometimes dropped: the captures (and, with `vitest`, a live Vitest run) may lack a
 * progress line that ES's engine, which keeps them in order, prints. `fewer` may lack progress
 * lines that `more` has once each; every other line must match.
 */
function onlyProgressMissing(fewer, more) {
  const rest = [...more]
  for (const line of fewer) {
    const at = rest.indexOf(line)
    if (at < 0) return false
    rest.splice(at, 1)
  }
  return rest.every((line) => PROGRESS.test(line) && more.filter((m) => m === line).length === 1)
}

function compare(expectedDir, actualDir, vitest = false) {
  const expected = load(expectedDir)
  const actual = load(actualDir)
  const problems = []
  let compared = 0
  let intended = 0
  let extra = 0
  for (const name of new Set([...expected.keys(), ...actual.keys()])) {
    const e = expected.get(name) ?? new Map()
    const a = actual.get(name) ?? new Map()
    for (const key of new Set([...e.keys(), ...a.keys()])) {
      const left = e.get(key) ?? []
      const right = a.get(key) ?? []
      // A run only the new side has comes from a test that stops earlier on the old engine (it
      // asserts the new behaviour); a run the new side lacks is a regression.
      if (right.length < left.length) {
        problems.push(`${name} ${key}: ran ${left.length} time(s), now ${right.length}`)
        continue
      }
      extra += right.length - left.length
      const allowed = INTENDED.filter((i) => i.file === name && i.key.test(key)).flatMap(
        (i) => i.fields,
      )
      const fields = ['code', 'live', 'summary', 'stderr', 'record']
      const live = (l, r) =>
        isDeepStrictEqual(l.live, r.live) ||
        (vitest ? onlyProgressMissing(r.live, l.live) : onlyProgressMissing(l.live, r.live))
      const equal = (f, l, r) => (f === 'live' ? live(l, r) : isDeepStrictEqual(l[f], r[f]))
      const same = (l, r) => fields.every((f) => allowed.includes(f) || equal(f, l, r))
      // Runs with the same key (concurrent tests of one project) may finish in either order.
      const unused = [...right]
      const pairs = left.map((l) => {
        const at = unused.findIndex((r) => same(l, r))
        return [l, unused.splice(at < 0 ? 0 : at, 1)[0]]
      })
      for (const [i, [l, r]] of pairs.entries()) {
        compared++
        for (const field of fields) {
          if (equal(field, l, r)) continue
          if (allowed.includes(field)) {
            intended++
            continue
          }
          problems.push(
            `${name} ${key} [${i}] ${field}:\n  expected ${JSON.stringify(l[field]).slice(0, 2000)}\n  actual   ${JSON.stringify(r[field]).slice(0, 2000)}`,
          )
        }
      }
    }
  }
  for (const p of problems) console.error(`✗ ${p}\n`)
  console.log(
    `differential: ${compared} runs compared, ${intended} intended differences, ${extra} runs only the new side made, ${problems.length} unexpected`,
  )
  return problems.length ? 1 : 0
}
