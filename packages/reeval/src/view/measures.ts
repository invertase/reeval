// One comparison of a variant with its baseline, over every measure the run has: pass rate, each
// check's pass rate, each judge's scores, each pairwise question's votes, and tool calls, agent
// time and tokens. Each measure keeps the test the output already prints it with, at its own
// alpha, so a verdict here never disagrees with a number shown elsewhere. The `reeval run` status
// list, `compare -v`, the tie remarks, the analyze digest and `reeval query measure_effects` all
// read it.
import { pairTallies } from '../compare/pairs.ts'
import { casePairs } from '../history/families.ts'
import type { AttemptRecord, CellCheck, EvalEntry, FamilyLift } from '../history/types.ts'
import {
  COMPARE_RUNS,
  containsZero,
  liftInterval,
  mannWhitney,
  mcnemar,
  median,
  minimumP,
  normalCdf,
  PAIRED_MIN,
  RUNS_TO_HOLD_MAX,
  runsToHold,
  signedRank,
} from '../stats.ts'
import { clip } from '../text.ts'
import {
  bothUnderATenth,
  EFFORT_ALPHA,
  type EffortSample,
  effortSample,
  effortVerdict,
} from './effort.ts'
import { labeledJudgments } from './judgments.ts'

export type MeasureName = 'pass' | 'check' | 'judge' | 'question' | 'tools' | 'agentMs' | 'tokens'

/**
 * `better` and `worse` are the measure's own test holding in that direction (for tool calls,
 * agent time and tokens, fewer is better); `leans` is a difference the test doesn't hold that
 * passes the lean screen (`screened`); `same` is every other difference, or none.
 */
export type MeasureVerdict = 'better' | 'worse' | 'same' | 'leans'

export type Measure = {
  measure: MeasureName
  /** The check's label, the judge's check, the question; null for the rest. */
  label: string | null
  /**
   * Each side's value: a pass rate (0–1), a mean judge score, a question's decisive pairs won, or
   * a median count, milliseconds or tokens.
   */
  variant: number
  control: number
  /**
   * The difference: pass-rate points (-1–1) for pass rate and checks, the mean score's difference
   * for a judge, the variant's share of decisive pairs for a question, and variant over control
   * for effort (null when the control's is 0).
   */
  estimate: number | null
  /** The 95% interval on pass-rate points; null for the other measures. */
  lo: number | null
  hi: number | null
  /** The test's two-sided p; null where the measure's verdict is an interval's (pass rate, checks). */
  p: number | null
  verdict: MeasureVerdict
  /** On a lean, which way it leans. */
  leaning: 'better' | 'worse' | null
  /** `5× faster`, `same pass rate`, `judge "tidy" +0.12`. */
  text: string
  /**
   * On a lean, the runs a side (a case, on a family) or the cases (`unit`) at which a lean this
   * size would hold; null past `RUNS_TO_HOLD_MAX`, or on any other verdict.
   */
  needed: number | null
  unit: 'runs' | 'cases'
  /**
   * On a lean whose test can't reach its lean p at this sample at all (two runs a side, or three,
   * for a rank test): the runs a side or cases (`unit`) it has (`now`) and the fewest at which it
   * can (`at`). Null otherwise.
   */
  short: { now: number; at: number } | null
}

type Side = { pass: number; counted: number }
/** Decisive pairs each side won, the pairs voted, and each side's votes (both orders of a pair). */
type Wins = {
  variant: number
  control: number
  voted: number
  variantVotes: number
  controlVotes: number
}

const LABEL_CHARS = 60

/**
 * What a difference its test doesn't hold needs to lean, else it reads `same`, so run-to-run noise
 * doesn't stand in for a difference: at least the measure's smallest effect (pass-rate points; a
 * judge's 0–1 score; a question's decisive win share; effort's relative difference in medians),
 * and its test's p below `LEAN_P`. A question needs `QUESTION_PAIRS_MIN` decisive pairs and a p
 * below `QUESTION_LEAN_P` instead: questions are few by design, so a unanimous 4 of 4 (p 0.125)
 * leans. A difference its test holds is better or worse at any size.
 */
export const RATE_MIN = 0.1
export const JUDGE_MIN = 0.05
export const QUESTION_MIN = 0.6
export const EFFORT_MIN = 0.1
export const LEAN_P = 0.1
export const QUESTION_LEAN_P = 0.2
export const QUESTION_PAIRS_MIN = 4

/**
 * A lean below its measure's smallest effect, or at a p of `leanP` or more, is `same`; unless a
 * sample this size can't reach `leanP` at all (`floor`, the test's smallest p at these sizes, ties
 * aside), when it stays a lean on too few runs, since its p says nothing.
 */
const screened = (
  verdict: MeasureVerdict,
  size: number,
  min: number,
  p: number | null,
  floor: number,
  leanP = LEAN_P,
): MeasureVerdict =>
  verdict === 'leans' && (size < min - 1e-9 || p === null || (p >= leanP && floor < leanP))
    ? 'same'
    : verdict

/** On a lean its test can't reach `LEAN_P` on, the sample it has and the fewest that can. */
const shortOf = (
  verdict: MeasureVerdict,
  floor: number,
  now: number,
  reaches: (n: number) => boolean,
): Measure['short'] =>
  verdict === 'leans' && floor >= LEAN_P ? { now, at: smallestFrom(now + 1, reaches) } : null

/** `12× faster, but 3 runs a side can't confirm it; 4 is the least that can`: a lean's text. */
export function leanText(m: Measure): string {
  if (!m.short) return m.text
  const { now, at } = m.short
  const has =
    m.unit === 'cases'
      ? `${now} ${now === 1 ? 'case' : 'cases'}`
      : `${now} ${now === 1 ? 'run' : 'runs'} a side`
  return `${m.text}, but ${has} can't confirm it; ${at} is the least that can`
}

/**
 * A measure as what the variant does, to follow its name or `It`: `runs 5× faster`, `uses 2.3×
 * more tokens`, `scores 0.97 higher on judge "tidy"`, `passes "builds" 50 points more often`.
 */
export function measurePhrase(m: Measure): string {
  if (m.verdict === 'same' || m.estimate === null) return m.text
  const label = m.label === null ? '' : `"${clip(m.label, LABEL_CHARS)}" `
  switch (m.measure) {
    case 'agentMs':
      return `runs ${m.text}`
    case 'tools':
    case 'tokens':
      return `uses ${m.text}`
    case 'judge':
      return `scores ${Math.abs(m.estimate).toFixed(2)} ${m.estimate > 0 ? 'higher' : 'lower'} on judge ${label.trimEnd()}`
    case 'pass':
    case 'check':
      return `passes ${label}${Math.round(Math.abs(m.estimate) * 100)} points ${m.estimate > 0 ? 'more' : 'less'} often`
    default:
      return m.text
  }
}

/** Two-sided p of a pooled two-proportion z test: it screens a rate's lean, never its verdict. */
function proportionP(v: Side, c: Side): number {
  const pooled = (v.pass + c.pass) / (v.counted + c.counted)
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / v.counted + 1 / c.counted))
  if (se === 0) return 1
  const z = Math.abs(v.pass / v.counted - c.pass / c.counted) / se
  return 2 * (1 - normalCdf(z))
}
const isCounted = (a: Pick<AttemptRecord, 'outcome'>) =>
  a.outcome === 'pass' || a.outcome === 'fail'
const sign = (x: number) => (x > 0 ? '+' : x < 0 ? '−' : '±')
const pts = (x: number) => `${sign(x)}${Math.round(Math.abs(x) * 100)} pts`
const mean = (n: readonly number[]) => n.reduce((a, b) => a + b, 0) / n.length

/** `5×`, `1.8×`, or `20%` below 1.5×: how many times, or how much, one side's median is the other's. */
function factor(ratio: number | null, lower: boolean): string {
  if (ratio === null || ratio <= 0) return ''
  const f = lower ? 1 / ratio : ratio
  if (f >= 1.5) return `${Number(f.toFixed(f >= 10 ? 0 : 1))}× `
  const pct = Math.round(Math.abs(1 - ratio) * 100)
  return pct ? `${pct}% ` : ''
}

/** The z a two-sided normal p corresponds to. */
function zOf(p: number): number {
  let lo = 0
  let hi = 40
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (2 * (1 - normalCdf(mid)) > p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

const smallestFrom = (from: number, reaches: (n: number) => boolean) => {
  let n = from
  while (!reaches(n)) n++
  return n
}
const smallest = (reaches: (n: number) => boolean) => smallestFrom(1, reaches)
/** Whether a sample of `n` a side (or `n` cases) can reach `LEAN_P` on each test. */
const rankReaches = (n: number) => minimumP(n, n) < LEAN_P
const signedReaches = (n: number) => 2 / 2 ** n < LEAN_P
const rateFloor = (nv: number, nc: number) =>
  proportionP({ pass: nv, counted: nv }, { pass: 0, counted: nc })
/** A rate confirms only from `COMPARE_RUNS` a side, where lift's interval can hold. */
const rateReaches = (n: number) => n >= COMPARE_RUNS && rateFloor(n, n) < LEAN_P

/**
 * The sample at which a rank test's lean would hold at `EFFORT_ALPHA`: at a fixed effect a z grows
 * with the square root of the sample, so the observed one scaled up to the critical z, and never
 * below the size whose smallest possible p reaches it (`floor`). A p of 1 on a difference (one run
 * a side) gives no z to scale, so the floor is all it can say.
 */
function scaled(p: number, now: number, floor: number): number | null {
  const z = zOf(p)
  if (z === 0) return Math.max(now + 1, floor)
  const n = Math.max(now + 1, floor, Math.ceil(now * (zOf(EFFORT_ALPHA) / z) ** 2))
  return n > RUNS_TO_HOLD_MAX ? null : n
}

const RANK_FLOOR = smallest((n) => minimumP(n, n) < EFFORT_ALPHA)
const SIGNED_FLOOR = smallest((n) => 2 / 2 ** n < EFFORT_ALPHA)

/**
 * The runs a side (a case, over `cases`) at which a question's decisive pairs would hold: one pair
 * a run, the same share of them decisive and the same share of those for the leading side,
 * through the exact sign test.
 */
function signRuns(wins: Wins, cases: number): number | null {
  const decisive = wins.variant + wins.control
  const share = Math.max(wins.variant, wins.control) / decisive
  const runs = wins.voted / cases
  for (let n = Math.floor(runs) + 1; n <= RUNS_TO_HOLD_MAX; n++) {
    const d = Math.round((decisive * n) / runs)
    const lead = Math.round(d * share)
    if (mcnemar(lead, d - lead) < EFFORT_ALPHA) return n
  }
  return null
}

/**
 * A pass rate's verdict, lift's maths: `same` at equal rates; `better` or `worse` when the
 * interval on the difference excludes 0 on `COMPARE_RUNS` or more a side; else `leans`, with the
 * runs at which the observed rates would hold.
 */
function rateMeasure(
  measure: 'pass' | 'check',
  label: string | null,
  v: Side,
  c: Side,
  stored?: { lo: number; hi: number },
): Measure {
  const vr = v.pass / v.counted
  const cr = c.pass / c.counted
  const computed = liftInterval({ pass: v.pass, n: v.counted }, { pass: c.pass, n: c.counted })
  const lo = stored?.lo ?? computed.low
  const hi = stored?.hi ?? computed.high
  const holds = !containsZero(lo, hi) && Math.min(v.counted, c.counted) >= COMPARE_RUNS
  const way = vr > cr ? 'better' : 'worse'
  const p = proportionP(v, c)
  const floor = rateFloor(v.counted, c.counted)
  const verdict = screened(
    vr === cr ? 'same' : holds ? way : 'leans',
    Math.abs(vr - cr),
    RATE_MIN,
    p,
    floor,
  )
  const name = measure === 'pass' ? 'pass rate' : `"${clip(label ?? '', LABEL_CHARS)}"`
  const from = Math.max(v.counted, c.counted, COMPARE_RUNS - 1) + 1
  return {
    measure,
    label,
    variant: vr,
    control: cr,
    estimate: vr - cr,
    lo,
    hi,
    p: null,
    verdict,
    leaning: verdict === 'leans' ? way : null,
    text: vr === cr ? `same ${name}` : `${name} ${pts(vr - cr)}`,
    needed:
      verdict !== 'leans'
        ? null
        : containsZero(lo, hi)
          ? runsToHold(vr, cr, from)
          : Math.max(from, COMPARE_RUNS),
    unit: 'runs',
    short: shortOf(verdict, floor, Math.min(v.counted, c.counted), rateReaches),
  }
}

/** A verdict from a test's p and the sign of its statistic (positive: the variant's is higher). */
const tested = (p: number, s: number, higherIsBetter: boolean): MeasureVerdict => {
  if (s === 0) return 'same'
  const better = s > 0 === higherIsBetter
  return p < EFFORT_ALPHA ? (better ? 'better' : 'worse') : 'leans'
}

const leaningOf = (verdict: MeasureVerdict, s: number, higherIsBetter: boolean) =>
  verdict === 'leans' ? (s > 0 === higherIsBetter ? 'better' : 'worse') : null

const EFFORT = [
  {
    measure: 'tools',
    pick: (s: EffortSample) => s.tools,
    words: (fewer: boolean) => (fewer ? 'fewer tool calls' : 'more tool calls'),
    same: 'same tool calls',
  },
  {
    measure: 'agentMs',
    pick: (s: EffortSample) => s.agentMs,
    words: (fewer: boolean) => (fewer ? 'faster' : 'slower'),
    same: 'same agent time',
  },
  {
    measure: 'tokens',
    pick: (s: EffortSample) => s.tokens,
    words: (fewer: boolean) => (fewer ? 'fewer tokens' : 'more tokens'),
    same: 'same tokens',
  },
] as const

/** Values of one effort measure, left out where an attempt didn't report it (tokens). */
const valuesOf = (
  samples: readonly EffortSample[],
  pick: (s: EffortSample) => number | undefined,
) =>
  samples.flatMap((s) => {
    const x = pick(s)
    return x === undefined ? [] : [x]
  })

/** One arm's counted attempts in one case (one entry, for a cell). */
type Arm = { attempts: readonly AttemptRecord[]; checks: readonly CellCheck[] | undefined }

type Input = {
  variant: Arm[]
  control: Arm[]
  pass: Measure
  questions: Map<string, Wins>
  /** A family's lift: effort is its paired verdict, by case. */
  family?: FamilyLift
}

function effortMeasures(input: Input, runs: number): Measure[] {
  const out: Measure[] = []
  const vs = input.variant.map((a) => a.attempts.map(effortSample))
  const cs = input.control.map((a) => a.attempts.map(effortSample))
  for (const m of EFFORT) {
    const v = valuesOf(vs.flat(), m.pick)
    const c = valuesOf(cs.flat(), m.pick)
    if (!v.length || !c.length) continue
    const vm = median(v) ?? 0
    const cm = median(c) ?? 0
    const ratio = cm === 0 ? null : vm / cm
    let p: number
    let s: number
    let floor: number
    let now: number
    let reaches: (n: number) => boolean
    let verdict: MeasureVerdict
    let needed: number | null = null
    let unit: 'runs' | 'cases' = 'runs'
    if (input.family?.effort) {
      const metric =
        m.measure === 'tokens' ? input.family.effort.tokens : input.family.effort[m.measure]
      if (!metric) continue
      const cases = casePairs(
        vs.map((x, i) => [x, cs[i] ?? []] as const),
        m.pick,
      )
      const test = signedRank(cases.map(([a, b]) => a - b))
      s = test?.sign ?? 0
      p = test?.p ?? 1
      now = cases.length
      floor = Math.min(1, 2 / 2 ** now)
      reaches = signedReaches
      verdict =
        metric.verdict === 'fewer'
          ? 'better'
          : metric.verdict === 'more'
            ? 'worse'
            : s === 0
              ? 'same'
              : 'leans'
      unit = 'cases'
      if (verdict === 'leans') needed = scaled(p, cases.length, Math.max(SIGNED_FLOOR, PAIRED_MIN))
    } else {
      const test = mannWhitney(v, c)
      if (!test) continue
      const printed = effortVerdict(v, c).verdict
      s = test.sign
      p = test.p
      floor = minimumP(v.length, c.length)
      now = Math.min(v.length, c.length)
      reaches = rankReaches
      verdict =
        printed === 'fewer' ? 'better' : printed === 'more' ? 'worse' : s === 0 ? 'same' : 'leans'
      if (verdict === 'leans') needed = scaled(p, runs, RANK_FLOOR)
    }
    verdict =
      m.measure === 'agentMs' && bothUnderATenth(vm, cm)
        ? 'same'
        : screened(
            verdict,
            ratio === null ? (vm === 0 ? 0 : Number.POSITIVE_INFINITY) : Math.abs(ratio - 1),
            EFFORT_MIN,
            p,
            floor,
          )
    if (verdict !== 'leans') needed = null
    const fewer = s < 0
    const agrees = (r: number | null): r is number => r !== null && r < 1 === fewer && r !== 1
    const cMean = mean(c)
    const meanRatio = cMean === 0 ? null : mean(v) / cMean
    const shown = agrees(ratio) ? ratio : agrees(meanRatio) ? meanRatio : null
    out.push({
      measure: m.measure,
      label: null,
      variant: vm,
      control: cm,
      estimate: ratio,
      lo: null,
      hi: null,
      p,
      verdict,
      leaning: leaningOf(verdict, s, false),
      text:
        verdict === 'same'
          ? m.same
          : `${shown === null ? '' : factor(shown, fewer)}${m.words(fewer)}`,
      needed,
      unit,
      short: shortOf(verdict, floor, now, reaches),
    })
  }
  return out
}

function checkMeasures(input: Input): Measure[] {
  const sum = (arms: Arm[]) => {
    const by = new Map<string, Side>()
    for (const arm of arms)
      for (const k of arm.checks ?? []) {
        const t = by.get(k.label) ?? { pass: 0, counted: 0 }
        t.pass += k.pass
        t.counted += k.pass + k.fail
        by.set(k.label, t)
      }
    return by
  }
  const v = sum(input.variant)
  const c = sum(input.control)
  return [...v].flatMap(([label, side]) => {
    const other = c.get(label)
    if (!other || !side.counted || !other.counted) return []
    return [rateMeasure('check', label, side, other)]
  })
}

function judgeMeasures(input: Input, runs: number): Measure[] {
  const scores = (arms: Arm[]) => {
    const by = new Map<string, number[]>()
    for (const a of arms.flatMap((x) => x.attempts))
      for (const j of labeledJudgments(a)) {
        const key = j.check ?? j.label
        by.set(key, [...(by.get(key) ?? []), j.judgment.score])
      }
    return by
  }
  const v = scores(input.variant)
  const c = scores(input.control)
  return [...v].flatMap(([label, xs]) => {
    const ys = c.get(label)
    const test = ys && mannWhitney(xs, ys)
    if (!ys || !test) return []
    const diff = mean(xs) - mean(ys)
    const verdict = screened(
      tested(test.p, test.sign, true),
      Math.abs(diff),
      JUDGE_MIN,
      test.p,
      minimumP(xs.length, ys.length),
    )
    const name = `judge "${clip(label, LABEL_CHARS)}"`
    return [
      {
        measure: 'judge',
        label,
        variant: mean(xs),
        control: mean(ys),
        estimate: diff,
        lo: null,
        hi: null,
        p: test.p,
        verdict,
        leaning: leaningOf(verdict, test.sign, true),
        text:
          verdict === 'same' ? `same ${name}` : `${name} ${sign(diff)}${Math.abs(diff).toFixed(2)}`,
        needed: verdict === 'leans' ? scaled(test.p, runs, RANK_FLOOR) : null,
        unit: 'runs',
        short: shortOf(
          verdict,
          minimumP(xs.length, ys.length),
          Math.min(xs.length, ys.length),
          rankReaches,
        ),
      } satisfies Measure,
    ]
  })
}

function questionMeasures(input: Input, cases: number): Measure[] {
  return [...input.questions].flatMap(([question, wins]): Measure[] => {
    if (!wins.voted) return []
    const decisive = wins.variant + wins.control
    const p = mcnemar(wins.variant, wins.control)
    const s = wins.variant - wins.control
    const verdict = screened(
      tested(p, s, true),
      decisive >= QUESTION_PAIRS_MIN ? Math.max(wins.variant, wins.control) / decisive : 0,
      QUESTION_MIN,
      p,
      0,
      QUESTION_LEAN_P,
    )
    const name = `"${clip(question, LABEL_CHARS)}"`
    const lead = s > 0 ? 'the variant' : 'the baseline'
    const votes = wins.variantVotes + wins.controlVotes
    const pairs = `${Math.max(wins.variant, wins.control)} of ${decisive} decisive ${decisive === 1 ? 'pair' : 'pairs'}`
    return [
      {
        measure: 'question',
        label: question,
        variant: wins.variant,
        control: wins.control,
        estimate: decisive ? wins.variant / decisive : null,
        lo: null,
        hi: null,
        p: decisive ? p : null,
        verdict,
        leaning: leaningOf(verdict, s, true),
        text:
          s === 0
            ? `${name} picked ${decisive ? 'each side as often' : 'neither'}`
            : `${name} picked ${lead} in ${s > 0 ? wins.variantVotes : wins.controlVotes} of ${votes} votes (${pairs})`,
        needed: verdict === 'leans' ? signRuns(wins, cases) : null,
        unit: 'runs',
        short: null,
      },
    ]
  })
}

function measuresOf(input: Input): Measure[] {
  const runs = Math.max(1, ...[...input.variant, ...input.control].map((a) => a.attempts.length))
  return [
    input.pass,
    ...effortMeasures(input, runs),
    ...judgeMeasures(input, runs),
    ...questionMeasures(input, input.variant.length),
    ...checkMeasures(input),
  ]
}

/**
 * Each pairwise question's decisive pairs for the variant and for the control, summed over the
 * entries. A pair decides only when both its orders pick the same side (or one is a tie): a split
 * followed the position, not the work, and a tie says nothing.
 */
function questionWins(
  pairs: ReadonlyArray<{
    entry: Pick<EvalEntry, 'answers' | 'cells'>
    variant: string
    control: string
  }>,
): Map<string, Wins> {
  const out = new Map<string, Wins>()
  for (const { entry, variant, control } of pairs) {
    const v = entry.cells.find((c) => c.key === variant)
    const c = entry.cells.find((x) => x.key === control)
    if (!v || !c || v.harness !== c.harness) continue
    for (const answer of entry.answers ?? []) {
      for (const t of pairTallies(answer.votes)) {
        if (t.cut !== 'within' || t.held !== v.harness) continue
        const forward = t.a === v.environment && t.b === c.environment
        const back = t.a === c.environment && t.b === v.environment
        if (!forward && !back) continue
        const wins = out.get(answer.question) ?? {
          variant: 0,
          control: 0,
          voted: 0,
          variantVotes: 0,
          controlVotes: 0,
        }
        wins.variant += forward ? t.aWins : t.bWins
        wins.control += forward ? t.bWins : t.aWins
        wins.voted += t.pairs
        out.set(answer.question, wins)
      }
      for (const vote of answer.votes) {
        const wins = out.get(answer.question)
        if (!wins || vote.cut !== 'within' || vote.harness !== v.harness) continue
        const sides = new Set([vote.a, vote.b])
        if (!sides.has(v.environment) || !sides.has(c.environment)) continue
        if (vote.winner === v.environment) wins.variantVotes++
        else if (vote.winner === c.environment) wins.controlVotes++
      }
    }
  }
  return out
}

const armOf = (e: Pick<EvalEntry, 'attempts' | 'cells'>, key: string): Arm => ({
  attempts: e.attempts.filter((a) => a.cell === key && isCounted(a)),
  checks: e.cells.find((c) => c.key === key)?.checks,
})

/** A variant cell against its control in one entry; null when either side counted nothing. */
export function cellMeasures(
  entry: Pick<EvalEntry, 'attempts' | 'answers' | 'cells'>,
  variant: string,
  control: string,
): Measure[] | null {
  const v = entry.cells.find((c) => c.key === variant)
  const c = entry.cells.find((x) => x.key === control)
  if (!v || !c || v.pass + v.fail === 0 || c.pass + c.fail === 0) return null
  const lift = v.lift?.vs === control ? v.lift : undefined
  return measuresOf({
    variant: [armOf(entry, variant)],
    control: [armOf(entry, control)],
    pass: rateMeasure(
      'pass',
      null,
      { pass: v.pass, counted: v.pass + v.fail },
      { pass: c.pass, counted: c.pass + c.fail },
      lift?.interval,
    ),
    questions: questionWins([{ entry, variant, control }]),
  })
}

/**
 * A family's variant against its control over its cases: pass rate is the family's pooled lift
 * (`lift`/`drop` hold, a difference within noise or `insufficient` leans), effort its paired
 * verdict by case, and checks, judges and questions every case's attempts pooled.
 */
export function familyMeasures(cases: readonly EvalEntry[], lift: FamilyLift): Measure[] {
  const paired = cases.filter(
    (e) =>
      e.cells.some((c) => c.key === lift.variant && c.pass + c.fail > 0) &&
      e.cells.some((c) => c.key === lift.vs && c.pass + c.fail > 0),
  )
  const same = lift.variantRate === lift.controlRate
  const way = lift.variantRate > lift.controlRate ? 'better' : 'worse'
  const verdict = screened(
    same
      ? 'same'
      : lift.verdict === 'lift'
        ? 'better'
        : lift.verdict === 'drop'
          ? 'worse'
          : 'leans',
    Math.abs(lift.points),
    RATE_MIN,
    lift.p,
    0,
  )
  return measuresOf({
    variant: paired.map((e) => armOf(e, lift.variant)),
    control: paired.map((e) => armOf(e, lift.vs)),
    pass: {
      measure: 'pass',
      label: null,
      variant: lift.variantRate,
      control: lift.controlRate,
      estimate: lift.points,
      lo: lift.interval.lo,
      hi: lift.interval.hi,
      p: lift.p,
      verdict,
      leaning: verdict === 'leans' ? way : null,
      text: same ? 'same pass rate' : `pass rate ${pts(lift.points)}`,
      needed: null,
      unit: 'cases',
      short: null,
    },
    questions: questionWins(
      paired.map((entry) => ({ entry, variant: lift.variant, control: lift.vs })),
    ),
    family: lift,
  })
}

/**
 * What a comparison says beyond pass rate. `apart`: some measure is better or worse, so the
 * comparison is the result. `leans`: none is, but some measure leans, with the soonest runs at
 * which one would hold (cases only when no lean is counted in runs, since the two don't compare).
 * `same`: every measure is level, or nothing else was measured.
 */
export type Reading =
  | { told: 'apart'; measures: Measure[] }
  | { told: 'leans'; measures: Measure[]; needed: number | null; unit: 'runs' | 'cases' }
  | { told: 'same' }

export function readMeasures(measures: readonly Measure[]): Reading {
  const rest = measures.filter((m) => m.measure !== 'pass')
  const apart = rest.filter((m) => m.verdict === 'better' || m.verdict === 'worse')
  if (apart.length) return { told: 'apart', measures: apart }
  const leans = rest.filter((m) => m.verdict === 'leans')
  if (!leans.length) return { told: 'same' }
  const confirmable = leans.filter((m) => m.needed !== null)
  const unit = confirmable.some((m) => m.unit === 'runs') ? 'runs' : 'cases'
  const soonest = confirmable
    .filter((m) => m.unit === unit)
    .sort((a, b) => (a.needed ?? 0) - (b.needed ?? 0))[0]
  return {
    told: 'leans',
    measures: leans,
    needed: soonest?.needed ?? null,
    unit: soonest?.unit ?? leans[0]?.unit ?? 'runs',
  }
}

/** `same pass rate · 5× faster · judge "tidy" +0.12`: pass rate, then the measures that hold. */
export const measuresLine = (measures: readonly Measure[], leans = false): string =>
  measures
    .filter(
      (m) =>
        m.measure === 'pass' ||
        m.verdict === 'better' ||
        m.verdict === 'worse' ||
        (leans && m.verdict === 'leans'),
    )
    .map((m) => (m.verdict === 'leans' && m.measure !== 'pass' ? `looks ${m.text}` : m.text))
    .join(' · ')

/**
 * Every side passed every counted run (`pass`), or failed every one (`fail`): a cell, or each of a
 * family's case cells. Null when they're mixed, or when any side counted nothing.
 */
export function boundOf(
  sides: ReadonlyArray<{ pass: number; fail: number }>,
): 'pass' | 'fail' | null {
  if (!sides.length || sides.some((s) => s.pass + s.fail === 0)) return null
  if (sides.every((s) => s.fail === 0)) return 'pass'
  return sides.every((s) => s.pass === 0) ? 'fail' : null
}

/**
 * How arms that both passed, or both failed, every run read: a floor is always a `tie` (a timeout
 * counts as a fail, so effort differs exactly when one arm hangs); a ceiling is a `tie` only when
 * every other measure is the same, a lean when some only lean, and null when one is better or
 * worse, since then the comparison is the result.
 */
export function tieOf(
  bound: 'pass' | 'fail',
  measures: readonly Measure[] | null,
): 'tie' | (Reading & { told: 'leans' }) | null {
  if (bound === 'fail') return 'tie'
  const reading = readMeasures(measures ?? [])
  return reading.told === 'same' ? 'tie' : reading.told === 'leans' ? reading : null
}
