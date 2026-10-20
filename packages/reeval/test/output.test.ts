// The result layouts `reeval run`, summary.md and `reeval show` print: each layout rendered from a
// corpus run and held to its golden, test/fixtures/output/<name>.txt (REEVAL_UPDATE_SNAPSHOTS=1
// rewrites them; review the diff), and the rules every layout keeps.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GOLDENS, goldenSuite, OUTPUT_DIR } from '../scripts/output/goldens.ts'
import { colors, stripAnsi } from '../src/ui/colors.ts'
import { layout, NO_MODEL_HINT, render, tallyLine } from '../src/ui/layout.ts'

const UPDATE = !!process.env.REEVAL_UPDATE_SNAPSHOTS
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

const rendered = (name: string) => {
  const g = GOLDENS.find((x) => x.name === name)
  assert.ok(g, name)
  return render(goldenSuite(g), null, { color: false, verbose: !!g.verbose })
}

describe('output goldens', () => {
  for (const g of GOLDENS) {
    test(g.name, () => {
      const text = `${rendered(g.name).join('\n')}\n`
      const file = join(OUTPUT_DIR, `${g.name}.txt`)
      if (UPDATE) {
        mkdirSync(OUTPUT_DIR, { recursive: true })
        writeFileSync(file, text)
      }
      assert.ok(existsSync(file), `no golden ${file}; run with REEVAL_UPDATE_SNAPSHOTS=1`)
      assert.equal(text, readFileSync(file, 'utf8'))
    })
  }
})

describe('every layout', () => {
  test('layout() picks the shape from what the eval varies, and a family keeps it', () => {
    for (const [across, kind] of [
      ['none', 'results'],
      ['change', 'measure'],
      ['harness', 'harnesses'],
      ['both', 'both'],
    ] as const) {
      assert.deepEqual(layout('other', across, false, false), { kind, family: false })
      assert.deepEqual(layout('other', across, true, false), { kind, family: true })
    }
  })

  test('ends with the tally and the hint, and counts read N of M, never a percentage', () => {
    for (const g of GOLDENS) {
      const lines = rendered(g.name)
      assert.equal(lines.at(-1), NO_MODEL_HINT, g.name)
      assert.match(lines.at(-2) ?? '', /^(\d+ (fail|pass|infra errors?|skipped)( · )?)+$/, g.name)
      if (!g.verbose) assert.doesNotMatch(lines.join('\n'), /\d%|pass@1|interval/, g.name)
    }
  })

  test('statistics only with -v', () => {
    for (const name of ['measure-a-change', 'family-with-change']) {
      assert.doesNotMatch(rendered(name).join('\n'), /interval|difference/, name)
      assert.match(rendered(`${name}-verbose`).join('\n'), /95% interval/, name)
    }
  })

  test("a check that didn't run reads not run, never 0 of N", () => {
    const text = rendered('measure-a-change').join('\n')
    assert.match(text, /^ {2}exclaims +not run {2}4 of 4 +not run$/m)
    assert.doesNotMatch(text, /^ {2}exclaims +0 of/m, 'canary: not 0 of N')
  })

  test('a pass prints its name only; a fail its failed checks and how many more passed', () => {
    const text = rendered('results').join('\n')
    assert.match(text, /^pass {13}writes greet\.js\n(\n|fail|infra|skipped|todo)/m)
    assert.match(text, /^fail {13}greets in French\n {2}french greeting +failed\n/m)
    assert.match(text, /^ {2}\+1 more passed$/m)
  })

  test('a question whose every vote was a tie says so under its heading', () => {
    const g = GOLDENS.find((x) => x.name === 'measure-a-change')
    assert.ok(g)
    const suite = goldenSuite(g)
    const e = suite.files[0]?.evals[0]
    assert.ok(e)
    e.questions = [{ question: 'Which reads better?', votes: 4, rates: [], error: null }]
    const text = render(suite, null, { color: false, verbose: false }).join('\n')
    assert.match(text, /^ {2}question {2}Which reads better\?\n {4}4 votes, every one a tie$/m)
  })

  test('a family case whose cells are all ungated reads not gated, never pass beside 0 of 1', () => {
    const g = GOLDENS.find((x) => x.name === 'family')
    assert.ok(g)
    const suite = goldenSuite(g)
    const e = suite.files.flatMap((f) => f.evals).find((x) => x.cases?.length)
    assert.ok(e?.cases)
    for (const k of e.cases) {
      k.outcome = 'pass'
      for (const cell of k.cells) {
        cell.gated = false
        cell.passed = 0
        cell.failed = 1
      }
    }
    const text = render(suite, null, { color: false, verbose: false }).join('\n')
    assert.match(text, /^ {2}not gated {2}\S.* +0 of 1$/m)
    assert.doesNotMatch(text, /^ {2}pass {2}\S.* +0 of 1$/m)
  })

  test('the tally puts fail first, leaves zeros out and counts infra errors and skips apart', () => {
    const c = colors(false)
    assert.equal(tallyLine(c, { pass: 2, fail: 5, infraError: 0, skipped: 0 }), '5 fail · 2 pass')
    assert.equal(
      tallyLine(c, { pass: 1, fail: 0, infraError: 2, skipped: 1 }),
      '1 pass · 2 infra errors · 1 skipped',
    )
    assert.equal(tallyLine(c, { pass: 0, fail: 0, infraError: 0, skipped: 0 }), 'no evals ran')
  })

  test('render is pure, and colour is the only difference colour makes', () => {
    const g = GOLDENS.find((x) => x.name === 'suite')
    assert.ok(g)
    const plain = render(goldenSuite(g), null, { color: false, verbose: false })
    assert.deepEqual(render(goldenSuite(g), null, { color: false, verbose: false }), plain)
    const painted = render(goldenSuite(g), null, { color: true, verbose: false })
    assert.ok(painted.some((l) => l.includes('\x1b[')))
    assert.deepEqual(painted.map(stripAnsi), plain)
  })
})

test('output:preview renders every corpus run and golden from src/', () => {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', 'scripts/output/preview.ts', 'all'],
    { cwd: PACKAGE_DIR, encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /\bundefined\b|\bNaN\b|\[object Object\]/)
  for (const g of GOLDENS) assert.match(r.stdout, new RegExp(`^── golden ${g.name}$`, 'm'))
  const bad = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', 'scripts/output/preview.ts', 'no-such-entry'],
    { cwd: PACKAGE_DIR, encoding: 'utf8' },
  )
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /^No corpus entry or golden no-such-entry\. Entries: /)
})
