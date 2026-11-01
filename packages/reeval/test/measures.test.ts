import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { EvalEntry } from '../src/history/types.ts'
import {
  boundOf,
  cellMeasures,
  leanText,
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

/** A pair's two votes, one in each order. */
const vote = (winner: string, i: number) =>
  [false, true].map((swapped) => ({
    cut: 'within',
    harness: 'fake',
    run: i + 1,
    a: 'plain',
    b: 'marked',
    winner,
    swapped,
  }))

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
      ? [
          {
            question: 'Which is clearer?',
            model: 'fake',
            votes: opts.winners.flatMap(vote),
            rates: [],
          },
        ]
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
    const spread = (lo: number, hi: number) =>
      Array.from({ length: 16 }, (_, i) => ({ ms: Math.round(lo + ((hi - lo) * i) / 15) }))
    const ms = cellMeasures(entry(spread(700, 1100), spread(800, 1200)), 'marked', 'plain')
    const time = of(ms, 'agentMs')
    assert.equal(
      time.verdict,
      'leans',
      'medians 900 against 1000 at p 0.06: under 0.1, short of 0.05',
    )
    assert.equal(time.leaning, 'better')
    assert.equal(time.text, '10% faster')
    assert.ok((time.needed ?? 0) > 16)
    const wide = cellMeasures(
      entry(
        [700, 800, 1100, 1200].map((ms) => ({ ms })),
        [1000, 1050, 1100, 1150].map((ms) => ({ ms })),
      ),
      'marked',
      'plain',
    )
    assert.equal(of(wide, 'agentMs').verdict, 'same', '12% at p 0.49 is noise: p is 0.1 or more')
    const reading = tieOf('pass', ms)
    assert.ok(reading && reading !== 'tie' && reading.told === 'leans')
    assert.equal(reading.needed, time.needed)
    assert.equal(measuresLine(ms ?? []), 'same pass rate', 'a lean is left out by default')
    assert.equal(measuresLine(ms ?? [], true), 'same pass rate · looks 10% faster')
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
    assert.equal(
      faint.text,
      '"Which is clearer?" picked the variant in 10 of 18 votes (5 of 9 decisive pairs)',
    )
    assert.equal(asked(times(4, 'marked')).verdict, 'leans', '4 of 4: enough pairs, p 0.125')
    assert.equal(asked(times(3, 'marked')).verdict, 'same', '3 decisive pairs are fewer than 4')
    assert.equal(
      asked([...times(6, 'marked'), ...times(3, 'plain')]).verdict,
      'same',
      '6 of 9 is 60/40, but p 0.51 is 0.2 or more',
    )
    const single = asked(['marked'])
    assert.equal(single.verdict, 'same', 'one decisive pair is fewer than 4')
    assert.equal(
      single.text,
      '"Which is clearer?" picked the variant in 2 of 2 votes (1 of 1 decisive pair)',
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
    assert.equal(checked(18).verdict, 'same', '18 of 20 is 10 points, but p 0.15 is 0.1 or more')
    assert.equal(checked(17).verdict, 'leans', '17 of 20 is 15 points at p 0.07')
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
    assert.equal(
      held.text,
      '"Which is clearer?" picked the variant in 16 of 16 votes (8 of 8 decisive pairs)',
    )
    assert.equal(asked(times(3, 'marked')).verdict, 'same', '3 decisive pairs are fewer than 4')
    const four = asked(times(4, 'marked'))
    assert.equal(four.verdict, 'leans', '4 of 4 is p 0.125, under 0.2')
    assert.equal(four.needed, 6, 'the fewest runs at which 6 of 6 decisive pairs hold (p 0.031)')
    assert.equal(
      asked(['plain', 'plain', 'plain']).text,
      '"Which is clearer?" picked the baseline in 6 of 6 votes (3 of 3 decisive pairs)',
    )
    assert.equal(asked(['plain', 'marked', 'tie']).verdict, 'same')
    assert.equal(asked(['tie', 'tie']).text, '"Which is clearer?" picked neither')
  })

  test('a judge is tested on its scores, a check on its own pass rate', () => {
    const spread = (xs: number[]) => xs.map((score) => ({ score }))
    const lone = cellMeasures(
      entry(spread([0.9, 0.5, 0.5, 0.5]), spread([0.5, 0.5, 0.5, 0.5])),
      'marked',
      'plain',
    )
    assert.equal(of(lone, 'judge').verdict, 'same', 'one higher score of four: p 0.1 or more')
    const judged = cellMeasures(
      entry(spread([0.9, 0.8, 0.7, 0.6, 0.6, 0.5]), spread([0.7, 0.6, 0.5, 0.5, 0.4, 0.4])),
      'marked',
      'plain',
    )
    const judge = of(judged, 'judge')
    assert.equal(judge.label, 'Is it tidy')
    assert.equal(judge.verdict, 'leans', 'p 0.09: under 0.1, short of the rank test')
    assert.equal(judge.text, 'judge "Is it tidy" +0.17')
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

  test('a difference too few runs can test is short of runs, never the same', () => {
    const fast = [50, 55, 60].map((ms) => ({ ms: ms * 10 }))
    const slow = [600, 650, 700].map((ms) => ({ ms: ms * 10 }))
    const time = of(cellMeasures(entry(fast, slow), 'marked', 'plain'), 'agentMs')
    assert.equal(time.verdict, 'leans', '3 a side: a rank test can reach no p below 0.1')
    assert.deepEqual(time.short, { now: 3, at: 4 })
    assert.equal(
      leanText(time),
      "12× faster, but 3 runs a side can't confirm it; 4 is the least that can",
    )
    const scored = (xs: number[]) => xs.map((score) => ({ score }))
    const judge = of(
      cellMeasures(entry(scored([0.9, 0.9, 0.9]), scored([0.4, 0.4, 0.4])), 'marked', 'plain'),
      'judge',
    )
    assert.notEqual(judge.verdict, 'same', 'judge 0.9 against 0.4 at 3 a side')
    assert.deepEqual(judge.short, { now: 3, at: 4 })
    const reading = tieOf('pass', cellMeasures(entry(fast, slow), 'marked', 'plain'))
    assert.ok(
      reading && reading !== 'tie' && reading.told === 'leans',
      'a ceiling it shows on is no tie',
    )
    const wide = cellMeasures(
      entry(
        [700, 800, 1100, 1200].map((ms) => ({ ms })),
        [1000, 1050, 1100, 1150].map((ms) => ({ ms })),
      ),
      'marked',
      'plain',
    )
    assert.equal(of(wide, 'agentMs').short, null, '4 a side can reach 0.1, so p 0.49 is the same')
    const one = cellMeasures(entry([{}], [{ pass: false }]), 'marked', 'plain')
    assert.deepEqual(
      of(one, 'pass').short,
      { now: 1, at: 4 },
      '1 against 0 can reach no p below 0.1, and a rate holds from 4 a side',
    )
  })

  test('agent times that both print <0.1s are the same, whatever their test says', () => {
    const quick = [3, 3, 4, 4].map((ms) => ({ ms }))
    const slower = [6, 6, 7, 7].map((ms) => ({ ms }))
    const ms = cellMeasures(entry(quick, slower), 'marked', 'plain')
    assert.equal(of(ms, 'agentMs').verdict, 'same', '3–4 ms against 6–7 ms is jitter')
    assert.equal(tieOf('pass', ms), 'tie')
  })

  test('a reading names the soonest runs, and cases only when no lean is counted in runs', () => {
    const lean = (unit: 'runs' | 'cases', needed: number): Measure => ({
      measure: unit === 'runs' ? 'judge' : 'agentMs',
      label: null,
      variant: 1,
      control: 0,
      estimate: 1,
      lo: null,
      hi: null,
      p: 0.1,
      verdict: 'leans',
      leaning: 'better',
      text: unit,
      needed,
      unit,
    })
    assert.deepEqual(readMeasures([lean('cases', 7), lean('runs', 30)]), {
      told: 'leans',
      measures: [lean('cases', 7), lean('runs', 30)],
      needed: 30,
      unit: 'runs',
    })
    const cases = readMeasures([lean('cases', 9), lean('cases', 7)])
    assert.ok(cases.told === 'leans' && cases.needed === 7 && cases.unit === 'cases')
  })

  test('a bound needs every side counted: one side with nothing counted is no bound', () => {
    assert.equal(
      boundOf([
        { pass: 4, fail: 0 },
        { pass: 4, fail: 0 },
      ]),
      'pass',
    )
    assert.equal(
      boundOf([
        { pass: 0, fail: 4 },
        { pass: 0, fail: 4 },
      ]),
      'fail',
    )
    assert.equal(
      boundOf([
        { pass: 4, fail: 0 },
        { pass: 0, fail: 0 },
      ]),
      null,
    )
    assert.equal(
      boundOf([
        { pass: 4, fail: 0 },
        { pass: 3, fail: 1 },
      ]),
      null,
    )
    assert.equal(boundOf([]), null)
  })

  test('identical arms that always pass are mostly a tie and seldom lean (seeded null draws)', () => {
    let seed = 764
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())
    const draw = (): Try => ({
      ms: Math.round(60_000 * Math.exp(0.15 * normal())),
      tools: Math.round(20 * Math.exp(0.25 * normal())),
      tokens: Math.round(200_000 * Math.exp(0.2 * normal())),
    })
    for (const n of [4, 8]) {
      seed = 764
      const read = { tie: 0, leans: 0, apart: 0 }
      const draws = 1000
      for (let i = 0; i < draws; i++) {
        const side = () => Array.from({ length: n }, draw)
        const t = tieOf('pass', cellMeasures(entry(side(), side()), 'marked', 'plain'))
        read[t === 'tie' ? 'tie' : t === null ? 'apart' : 'leans']++
      }
      const share = (k: keyof typeof read) => read[k] / draws
      assert.ok(share('tie') > 0.7, `${n} a side: a tie is the usual reading, ${share('tie')}`)
      assert.ok(share('leans') < 0.12, `${n} a side: noise seldom leans, ${share('leans')}`)
      assert.ok(
        share('apart') < (n === 4 ? 0.1 : 0.18),
        `${n} a side: a chance better or worse stays near 5% a measure, ${share('apart')}`,
      )
    }
  })
})
