import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { EvalEntry } from '../src/history/types.ts'
import {
  cellMeasures,
  type Measure,
  measuresLine,
  readMeasures,
  tieOf,
} from '../src/view/measures.ts'

type Try = {
  pass?: boolean
  ms?: number
  tools?: number
  tokens?: number
  score?: number
}

const attempt = (cell: string, t: Try, i: number) => ({
  cell,
  run: i + 1,
  outcome: t.pass === false ? 'fail' : 'pass',
  timings: { agentMs: t.ms ?? 1000 },
  activity: { tools: t.tools ?? 5, fileEdits: 1 },
  changedFiles: [],
  usage: { input: t.tokens ?? 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
  judgements:
    t.score === undefined
      ? []
      : [{ question: 'Is it tidy?', verdict: 'pass', score: t.score, threshold: 0.5 }],
  assertions: [],
})

const vote = (winner: string, i: number) => ({
  cut: 'within',
  harness: 'fake',
  run: i + 1,
  a: 'plain',
  b: 'marked',
  winner,
  swapped: false,
})

/** One entry: `marked` (the variant) against `plain`, with each side's tries and a question's winners. */
function entry(
  variant: Try[],
  control: Try[],
  opts: { winners?: string[]; checks?: [number, number] } = {},
): EvalEntry {
  const count = (tries: Try[]) => ({
    pass: tries.filter((t) => t.pass !== false).length,
    fail: tries.filter((t) => t.pass === false).length,
  })
  const check = (pass: number, n: number) => [
    { label: 'compiles', pass, fail: n - pass, error: 0, notRun: 0 },
  ]
  const [vPass, cPass] = opts.checks ?? []
  return {
    cells: [
      {
        key: 'plain',
        harness: 'fake',
        environment: 'plain',
        ...count(control),
        ...(cPass === undefined ? {} : { checks: check(cPass, control.length) }),
      },
      {
        key: 'marked',
        harness: 'fake',
        environment: 'marked',
        ...count(variant),
        ...(vPass === undefined ? {} : { checks: check(vPass, variant.length) }),
      },
    ],
    attempts: [
      ...variant.map((t, i) => attempt('marked', t, i)),
      ...control.map((t, i) => attempt('plain', t, i)),
    ],
    answers: opts.winners
      ? [{ question: 'Which is clearer?', model: 'fake', votes: opts.winners.map(vote), rates: [] }]
      : [],
  } as unknown as EvalEntry
}

const times = <T>(n: number, x: T): T[] => Array.from({ length: n }, () => x)
const of = (ms: Measure[] | null, name: Measure['measure']) => {
  const m = ms?.find((x) => x.measure === name)
  assert.ok(m, `no ${name} measure`)
  return m
}

describe('one comparison over every measure', () => {
  test('identical arms are the same on every measure, so a ceiling is a tie', () => {
    const ms = cellMeasures(entry(times(4, {}), times(4, {})), 'marked', 'plain')
    assert.deepEqual(
      ms?.map((m) => `${m.measure}:${m.verdict}`),
      ['pass:same', 'tools:same', 'agentMs:same', 'tokens:same'],
    )
    assert.equal(of(ms, 'agentMs').text, 'same agent time')
    assert.deepEqual(readMeasures(ms ?? []), { told: 'same' })
    assert.equal(tieOf('pass', ms), 'tie')
    assert.equal(measuresLine(ms ?? []), 'same pass rate')
  })

  test('effort its rank test holds is better, with a factor, and a ceiling is no tie', () => {
    const fast = [100, 110, 120, 130].map((ms) => ({ ms, tokens: 100 }))
    const slow = [1000, 1100, 1200, 1300].map((ms) => ({ ms, tokens: 1000 }))
    const ms = cellMeasures(entry(fast, slow), 'marked', 'plain')
    const time = of(ms, 'agentMs')
    assert.equal(time.verdict, 'better')
    assert.equal(time.text, '10× faster')
    assert.equal(time.needed, null)
    assert.equal(of(ms, 'tokens').text, '10× fewer tokens')
    assert.equal(readMeasures(ms ?? []).told, 'apart')
    assert.equal(tieOf('pass', ms), null, 'the comparison is the result')
    assert.equal(tieOf('fail', ms), 'tie', 'both failing is always a tie, whatever else differs')
    assert.equal(measuresLine(ms ?? []), 'same pass rate · 10× faster · 10× fewer tokens')
    const slower = cellMeasures(entry(slow, fast), 'marked', 'plain')
    assert.equal(of(slower, 'agentMs').verdict, 'worse')
    assert.equal(of(slower, 'agentMs').text, '10× slower')
  })

  test('a difference the test does not hold leans, with the runs a side that would hold it', () => {
    const variant = [700, 800, 1100, 1200].map((ms) => ({ ms }))
    const control = [1000, 1050, 1100, 1150].map((ms) => ({ ms }))
    const ms = cellMeasures(entry(variant, control), 'marked', 'plain')
    const time = of(ms, 'agentMs')
    assert.equal(time.verdict, 'leans', 'medians 950 against 1075: 12%, short of the rank test')
    assert.equal(time.leaning, 'better')
    assert.equal(time.text, '12% faster')
    assert.ok((time.needed ?? 0) > 4)
    const reading = tieOf('pass', ms)
    assert.ok(reading && reading !== 'tie' && reading.told === 'leans')
    assert.equal(reading.needed, time.needed)
    assert.equal(measuresLine(ms ?? []), 'same pass rate', 'a lean is left out by default')
    assert.equal(measuresLine(ms ?? [], true), 'same pass rate · looks 12% faster')
  })

  test('a difference below its measure minimum that its test does not hold is the same', () => {
    const noise = [1000, 1040, 980, 1020].map((ms) => ({ ms }))
    const ms = cellMeasures(entry(noise, times(4, { ms: 1000 })), 'marked', 'plain')
    assert.equal(of(ms, 'agentMs').verdict, 'same', 'medians 1010 against 1000: 1%, under 10%')
    assert.equal(of(ms, 'agentMs').text, 'same agent time')
    assert.equal(of(ms, 'agentMs').needed, null)
    assert.equal(tieOf('pass', ms), 'tie', 'agent-time noise leaves a ceiling a tie')
    const one = [{ ms: 500 }, ...times(15, { ms: 1000 })]
    assert.equal(
      of(cellMeasures(entry(one, times(16, { ms: 1000 })), 'marked', 'plain'), 'agentMs').verdict,
      'same',
      'one faster attempt of 16 leaves the medians level',
    )
    const scored = (xs: number[]) => xs.map((score) => ({ score }))
    const judged = cellMeasures(
      entry(scored([0.82, 0.8, 0.8, 0.8]), scored([0.8, 0.8, 0.8, 0.8])),
      'marked',
      'plain',
    )
    assert.equal(of(judged, 'judge').verdict, 'same', 'a 0.005 mean difference is under 0.05')
    const asked = (winners: string[]) =>
      of(
        cellMeasures(entry(times(9, {}), times(9, {}), { winners }), 'marked', 'plain'),
        'question',
      )
    const faint = asked([...times(5, 'marked'), ...times(4, 'plain')])
    assert.equal(faint.verdict, 'same', '5 of 9 decisive is under 60/40')
    assert.equal(faint.text, '"Which is clearer?" picked each side about as often')
    assert.equal(
      asked([...times(3, 'marked'), ...times(2, 'plain')]).verdict,
      'leans',
      '3 of 5 is 60/40',
    )
    const checked = (pass: number) =>
      of(
        cellMeasures(
          entry(times(20, {}), times(20, {}), { checks: [pass, 20] }),
          'marked',
          'plain',
        ),
        'check',
      )
    assert.equal(checked(19).verdict, 'same', '19 of 20 against 20 of 20 is 5 points')
    assert.equal(checked(19).text, '"compiles" −5 pts', 'a faint difference keeps its points')
    assert.equal(checked(18).verdict, 'leans', '18 of 20 is 10 points')
  })

  test('a significant effect is better or worse at any size', () => {
    const fast = [990, 991, 992, 993, 994, 995, 996, 997].map((ms) => ({ ms }))
    const slow = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007].map((ms) => ({ ms }))
    const time = of(cellMeasures(entry(fast, slow), 'marked', 'plain'), 'agentMs')
    assert.equal(time.verdict, 'better', 'a 1% difference its rank test holds')
    assert.equal(time.text, '1% faster')
  })

  test('a question is tested by the exact sign test on its decisive pairs', () => {
    const asked = (winners: string[]) =>
      of(
        cellMeasures(entry(times(8, {}), times(8, {}), { winners }), 'marked', 'plain'),
        'question',
      )
    const held = asked(times(8, 'marked'))
    assert.equal(held.verdict, 'better')
    assert.equal(held.text, '"Which is clearer?" picked the variant 8 of 8')
    const four = asked(times(4, 'marked'))
    assert.equal(four.verdict, 'leans', '4 of 4 is p 0.125')
    assert.equal(four.needed, 6, 'the fewest runs at which 6 of 6 decisive pairs hold (p 0.031)')
    assert.equal(
      asked(['plain', 'plain', 'plain']).text,
      '"Which is clearer?" picked the baseline 3 of 3',
    )
    assert.equal(asked(['plain', 'marked', 'tie']).verdict, 'same')
    assert.equal(asked(['tie', 'tie']).text, '"Which is clearer?" picked neither')
  })

  test('a judge is tested on its scores, a check on its own pass rate', () => {
    const spread = (xs: number[]) => xs.map((score) => ({ score }))
    const judged = cellMeasures(
      entry(spread([0.9, 0.5, 0.5, 0.5]), spread([0.5, 0.5, 0.5, 0.5])),
      'marked',
      'plain',
    )
    const judge = of(judged, 'judge')
    assert.equal(judge.label, 'Is it tidy')
    assert.equal(judge.verdict, 'leans', 'one higher score of four is short of the rank test')
    assert.equal(judge.text, 'judge "Is it tidy" +0.10')
    const more = cellMeasures(
      entry(spread([0.9, 0.85, 0.95, 0.8, 0.9, 0.85]), spread([0.4, 0.5, 0.45, 0.3, 0.5, 0.4])),
      'marked',
      'plain',
    )
    assert.equal(of(more, 'judge').verdict, 'better')
    assert.equal(of(more, 'judge').text, 'judge "Is it tidy" +0.45')
    const checked = cellMeasures(
      entry(times(4, {}), times(4, {}), { checks: [4, 0] }),
      'marked',
      'plain',
    )
    const check = of(checked, 'check')
    assert.equal(check.verdict, 'better')
    assert.equal(check.text, '"compiles" +100 pts')
  })

  test('pass rate keeps lift: a split under 4 runs a side leans, an equal rate is the same', () => {
    const lean = cellMeasures(entry(times(2, {}), times(2, { pass: false })), 'marked', 'plain')
    assert.equal(of(lean, 'pass').verdict, 'leans')
    assert.equal(of(lean, 'pass').text, 'pass rate +100 pts')
    const held = cellMeasures(entry(times(4, {}), times(4, { pass: false })), 'marked', 'plain')
    assert.equal(of(held, 'pass').verdict, 'better')
    assert.equal(readMeasures(held ?? []).told, 'same', 'the reading leaves pass rate out')
  })
})
