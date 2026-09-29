// The replay of the side-by-side comparison of reeval's engine with the Vitest engine it replaced
// (packages/reeval/test/support/differential.ts). Every `reeval` the suites run is captured,
// normalised, and compared by test file and call with what the Vitest engine did, which
// test/differential/vitest/ holds.
//
//   node --experimental-strip-types scripts/differential.mjs record <dir>   run the suites into <dir>
//   node --experimental-strip-types scripts/differential.mjs compare <expected> <actual>
//                                    fail on any difference not in INTENDED
//
// A deliberate change to what `reeval` prints or records updates the captures it touches (by hand,
// or `record` then copy the files), with the change named in the PR.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { renormalise } from '../packages/reeval/test/support/differential.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = join(root, 'packages/reeval')

/**
 * Every test file that runs `reeval` through runCli, on the fake sandbox; not `reeval doctor`'s, which
 * reports the host (Node, npm, Docker), not what the engine does.
 */
const SUITES = readdirSync(join(pkg, 'test'))
  .filter((f) => f.endsWith('.test.ts'))
  .filter(
    (f) =>
      !/^(docker|docker-antigravity|studio|pack|contract|e2e-real|real-tier|questions-real|doctor)\.test\.ts$/.test(
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
    why: "Vitest left a dead worker's attempts without a result (skipped); reeval fails them, naming the file and signal.",
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
  {
    file: 'example.test.ts.jsonl',
    key: /^hello-copy run --config reeval\.fake\.config\.ts$/,
    fields: ['live'],
    why: 'The fake config turns on analysis.agent, so the run prints where it wrote its notes (#149).',
  },
  {
    file: 'analysis.test.ts.jsonl',
    key: /^analyze-errors analyze$/,
    fields: ['stderr'],
    why: 'An unknown key in config.analysis lists agent among the keys it takes (#149).',
  },
  {
    file: 'example.test.ts.jsonl',
    key: /^hello-copy run --config reeval\.fake\.config\.ts( --dry-run --json)?$/,
    fields: ['summary', 'live', 'record'],
    why: "compare question answers: skill.eval.ts's compare asks a question, so the plan lists it and the run records and prints its answer.",
  },
]

/** An attempt's progress line, which the Vitest engine could drop (see `onlyProgressMissing`). */
const PROGRESS = /\] {2}\+<t> /

const [command, ...args] = process.argv.slice(2)
if (command === 'record') process.exit(record(resolve(args[0])))
else if (command === 'compare') process.exit(compare(resolve(args[0]), resolve(args[1])))
else {
  console.error('usage: node scripts/differential.mjs record <dir> | compare <expected> <actual>')
  process.exit(2)
}

function record(dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const env = { ...process.env, REEVAL_DIFFERENTIAL_DIR: dir, REEVAL_FIXTURE_TIERS: 'fake' }
  const tests = spawnSync(
    process.execPath,
    ['--test', '--test-timeout=600000', '--experimental-strip-types', '--no-warnings', ...SUITES],
    { cwd: pkg, env, stdio: ['ignore', 'ignore', 'inherit'] },
  )
  // A failing test is the unit jobs' to report; a run it didn't reach shows up in `compare`.
  console.log(`differential: recorded into ${dir} (tests exited ${tests.status})`)
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
 * result was sometimes dropped: the captures may lack a progress line that reeval's engine, which
 * keeps them in order, prints. `fewer` may lack progress lines that `more` has once each; every
 * other line must match.
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

function compare(expectedDir, actualDir) {
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
      // A run only the new side has comes from a test that stopped earlier on the Vitest engine
      // (it asserts the new behaviour); a run the new side lacks is a regression.
      if (right.length < left.length) {
        problems.push(`${name} ${key}: ran ${left.length} time(s), now ${right.length}`)
        continue
      }
      extra += right.length - left.length
      const allowed = INTENDED.filter((i) => i.file === name && i.key.test(key)).flatMap(
        (i) => i.fields,
      )
      const fields = ['code', 'live', 'summary', 'stderr', 'record']
      const equal = (f, l, r) =>
        isDeepStrictEqual(l[f], r[f]) || (f === 'live' && onlyProgressMissing(l.live, r.live))
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
