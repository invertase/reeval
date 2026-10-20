// The result layouts `reeval run`, summary.md and `reeval show` print, and `reeval compare`'s: each
// layout rendered from corpus runs and held to its golden, test/fixtures/output/<name>.txt
// (REEVAL_UPDATE_SNAPSHOTS=1 rewrites them; review the diff), and the rules every layout keeps.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  COMPARE_GOLDENS,
  type CompareGolden,
  GOLDENS,
  goldenCompare,
  goldenSuite,
  OUTPUT_DIR,
} from '../scripts/output/goldens.ts'
import { corpusEntries } from '../scripts/schema/corpus.ts'
import { hasAnalysisModel } from '../src/config.ts'
import type { ResolvedConfig } from '../src/types.ts'
import { colors, stripAnsi } from '../src/ui/colors.ts'
import {
  type CompareInput,
  compareTally,
  renderCompare,
  renderCompareMarkdown,
} from '../src/ui/compare-layout.ts'
import { layout, NO_MODEL_HINT, render, tallyLine } from '../src/ui/layout.ts'

const UPDATE = !!process.env.REEVAL_UPDATE_SNAPSHOTS
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

const rendered = (name: string) => {
  const g = GOLDENS.find((x) => x.name === name)
  assert.ok(g, name)
  return render(goldenSuite(g), null, { color: false, verbose: !!g.verbose, hint: true })
}

const comparedText = (g: CompareGolden, input = goldenCompare(g)) =>
  renderCompare(input, { color: false, verbose: !!g.verbose })

const compareGolden = (name: string) => {
  const g = COMPARE_GOLDENS.find((x) => x.name === name)
  assert.ok(g, name)
  return g
}

describe('output goldens', () => {
  for (const g of [...GOLDENS, ...COMPARE_GOLDENS]) {
    test(g.name, () => {
      const lines = COMPARE_GOLDENS.includes(g as CompareGolden)
        ? comparedText(g as CompareGolden)
        : rendered(g.name)
      const text = `${lines.join('\n')}\n`
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

  test('the hint prints only while analysis.model is unset; with it, the tally ends the run', () => {
    const g = GOLDENS.find((x) => x.name === 'suite')
    assert.ok(g)
    const without = render(goldenSuite(g), null, { color: false, verbose: false, hint: true })
    const withModel = render(goldenSuite(g), null, { color: false, verbose: false, hint: false })
    assert.equal(without.at(-1), NO_MODEL_HINT)
    assert.ok(!withModel.includes(NO_MODEL_HINT))
    assert.match(withModel.at(-1) ?? '', /^(\d+ (fail|pass|infra errors?|skipped)( · )?)+$/)
    assert.deepEqual(withModel, without.slice(0, -1))
  })

  test('an analysis model is analysis.model only, never the judge', () => {
    const config = (analysis: unknown, judge: unknown) =>
      ({ analysis: { model: analysis }, judge: { model: judge } }) as unknown as ResolvedConfig
    assert.equal(hasAnalysisModel(config(undefined, undefined)), false)
    assert.equal(hasAnalysisModel(config(undefined, 'typesafe-ai/jev-1.14.0')), false)
    assert.equal(hasAnalysisModel(config(undefined, { kind: 'fake' })), false)
    assert.equal(hasAnalysisModel(config(undefined, 'google/gemini-3.8-flash')), false)
    assert.equal(
      hasAnalysisModel(config('google/gemini-3.8-flash', 'typesafe-ai/jev-1.14.0')),
      true,
    )
    assert.equal(hasAnalysisModel(config({ kind: 'fake-analysis' }, undefined)), true)
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
    const text = render(suite, null, { color: false, verbose: false, hint: true }).join('\n')
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
    const text = render(suite, null, { color: false, verbose: false, hint: true }).join('\n')
    assert.match(text, /^ {2}not gated {2}\S.* +0 of 1$/m)
    assert.doesNotMatch(text, /^ {2}pass {2}\S.* +0 of 1$/m)
  })

  test('cancelled and skipped tries are named beside the count, never counted as fails', () => {
    const g = GOLDENS.find((x) => x.name === 'results')
    assert.ok(g)
    const suite = goldenSuite(g)
    const e = suite.files
      .flatMap((f) => f.evals)
      .find((x) => x.name === 'explains why greet.js fails')
    const cell = e?.cells?.[0]
    assert.ok(cell)
    cell.attempts = 4
    cell.failed = 2
    cell.skipped = 1
    cell.errors.push({ kind: 'aborted', message: 'The run was cancelled', attempts: 1 })
    const text = render(suite, null, { color: false, verbose: false, hint: true }).join('\n')
    assert.match(text, /^ {2}4 tries +1 of 2 · 1 cancelled · 1 skipped$/m)
    assert.doesNotMatch(text, /^ {2}4 tries +1 of 3/m, 'canary: a cancelled try is not a fail')
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
    const plain = render(goldenSuite(g), null, { color: false, verbose: false, hint: true })
    assert.deepEqual(
      render(goldenSuite(g), null, { color: false, verbose: false, hint: true }),
      plain,
    )
    const painted = render(goldenSuite(g), null, { color: true, verbose: false, hint: true })
    assert.ok(painted.some((l) => l.includes('\x1b[')))
    assert.deepEqual(painted.map(stripAnsi), plain)
  })
})

describe('catch regressions (reeval compare)', () => {
  test('ends with the tally: regressed first, zeros left out, no statistics without -v', () => {
    const full = comparedText(compareGolden('compare'))
    assert.equal(
      full.at(-1),
      "1 regressed · 1 fixed · 1 can't compare · 1 new · 1 removed · 4 same",
    )
    for (const g of COMPARE_GOLDENS.filter((x) => !x.verbose)) {
      assert.doesNotMatch(comparedText(g).join('\n'), /\d%|lift|interval|noise|×/, g.name)
    }
    assert.match(comparedText(compareGolden('compare-verbose')).join('\n'), /agent 0s → 0s \(×/)
    const c = colors(false)
    const row = (status: CompareInput['rows'][number]['status']) => ({
      id: status,
      status,
      base: null,
      head: null,
    })
    assert.equal(compareTally(c, [row('same'), row('fixed'), row('same')]), '1 fixed · 2 same')
    assert.equal(compareTally(c, [row('infra')]), '1 infra error')
    assert.equal(compareTally(c, []), 'no evals to compare')
  })

  test('a check not run on one side is not run, never a failure; a flip shows both sides', () => {
    const regressed = comparedText(compareGolden('compare-regressed')).join('\n')
    assert.match(regressed, /^ {2}house greeting {3}pass → fail\n {4}expected command to succeed/m)
    assert.match(regressed, /^ {2}sign-off {9}not run$/m)
    assert.doesNotMatch(regressed, /sign-off +(pass → )?fail/, 'canary: not printed as fail')
    const fixed = comparedText(compareGolden('compare-fixed')).join('\n')
    assert.match(fixed, /^ {2}build {12}fail → pass$/m)
    assert.match(fixed, /^ {2}types {12}not run → pass$/m)
    assert.doesNotMatch(fixed, /types +fail → pass/, 'canary: not run is not fail')
  })

  test('a check not run on both sides is no change: never a flip', () => {
    const g = compareGolden('compare-regressed')
    const input = goldenCompare(g)
    for (const side of [input.base, input.head]) {
      for (const e of side?.suite.files.flatMap((f) => f.evals) ?? []) {
        for (const cell of e.cells ?? []) {
          cell.checks.push({
            ...(cell.checks[0] as (typeof cell.checks)[number]),
            label: 'never reached',
            outcome: { status: 'not run' },
          })
        }
      }
    }
    const text = comparedText(g, input).join('\n')
    assert.match(text, /^ {2}never reached {4}not run$/m)
    assert.doesNotMatch(text, /never reached +\S+ → /, 'canary: not a flip')
    const fixed = compareGolden('compare-fixed')
    const fixedInput = goldenCompare(fixed)
    for (const side of [fixedInput.base, fixedInput.head]) {
      for (const k of side?.suite.files.flatMap((f) => f.evals).flatMap((e) => e.cases ?? []) ??
        []) {
        for (const cell of k.cells) {
          cell.checks.push({
            ...(cell.checks[0] as (typeof cell.checks)[number]),
            label: 'never reached',
            outcome: { status: 'not run' },
          })
        }
      }
    }
    assert.doesNotMatch(comparedText(fixed, fixedInput).join('\n'), /never reached/)
  })

  test('unchanged evals collapse to +N same in place, and the runs print once when no block names them', () => {
    const text = comparedText(compareGolden('compare-same-collapsed'))
    assert.deepEqual(text.slice(2), ['', '+4 same', '', '4 same'])
    assert.match(text[0] ?? '', /^base {13}\S+$/)
    const full = comparedText(compareGolden('compare')).join('\n')
    assert.doesNotMatch(full, /^base /m, 'a regressed block names them')
  })

  test('--md is the same layout in a text block under a heading naming both runs', () => {
    const g = compareGolden('compare')
    const input = goldenCompare(g)
    const md = renderCompareMarkdown(input, { color: true, verbose: false })
    assert.equal(
      md,
      [
        `### reeval compare: ${input.head.runId} vs ${input.base?.runId}`,
        '',
        '```text',
        ...comparedText(g),
        '```',
        '',
      ].join('\n'),
    )
  })

  test('colour is the only difference colour makes', () => {
    const input = goldenCompare(compareGolden('compare'))
    const plain = renderCompare(input, { color: false, verbose: false })
    const painted = renderCompare(input, { color: true, verbose: false })
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
  for (const g of [...GOLDENS, ...COMPARE_GOLDENS]) {
    assert.match(r.stdout, new RegExp(`^── golden ${g.name}$`, 'm'))
  }
  const [base, head] = (corpusEntries().find((e) => e.name === 'with-compare')?.runs ?? []).map(
    (run) => run.file,
  )
  const two = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      'scripts/output/preview.ts',
      `${base}`,
      `${head}`,
    ],
    { cwd: PACKAGE_DIR, encoding: 'utf8' },
  )
  assert.equal(two.status, 0, two.stderr)
  assert.match(two.stdout, /^── compare .*\n\ncan't compare {4}bills in minor units/m)
  const bad = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', 'scripts/output/preview.ts', 'no-such-entry'],
    { cwd: PACKAGE_DIR, encoding: 'utf8' },
  )
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /^No corpus entry or golden no-such-entry\. Entries: /)
})
