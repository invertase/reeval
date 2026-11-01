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
import { EFFORT_ALPHA, type EffortSample, effortSample, effortVerdict } from './effort.ts'
import { labeledJudgments } from './judgments.ts'

export type MeasureName = 'pass' | 'check' | 'judge' | 'question' | 'tools' | 'agentMs' | 'tokens'

/**
 * `better` and `worse` are the measure's own test holding in that direction (for tool calls,
 * agent time and tokens, fewer is better); `same` is no observed difference at all; `leans` is a
 * difference the test doesn't hold.
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
}

type Side = { pass: number; counted: number }
type Wins = { variant: number; control: number; voted: number }

const LABEL_CHARS = 60
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

const smallest = (reaches: (n: number) => boolean) => {
  let n = 1
  while (!reaches(n)) n++
  return n
}

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
  const verdict: MeasureVerdict = vr === cr ? 'same' : holds ? way : 'leans'
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
    text: verdict === 'same' ? `same ${name}` : `${name} ${pts(vr - cr)}`,
    needed:
      verdict !== 'leans'
        ? null
        : containsZero(lo, hi)
          ? runsToHold(vr, cr, from)
          : Math.max(from, COMPARE_RUNS),
    unit: 'runs',
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
      verdict =
        printed === 'fewer' ? 'better' : printed === 'more' ? 'worse' : s === 0 ? 'same' : 'leans'
      if (verdict === 'leans') needed = scaled(p, runs, RANK_FLOOR)
    }
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
    const verdict = tested(test.p, test.sign, true)
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
    const verdict = tested(p, s, true)
    const name = `"${clip(question, LABEL_CHARS)}"`
    const lead = s > 0 ? 'the variant' : 'the baseline'
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
          verdict === 'same'
            ? `${name} picked neither`
            : `${name} picked ${lead} ${Math.max(wins.variant, wins.control)} of ${decisive}`,
        needed: verdict === 'leans' ? signRuns(wins, cases) : null,
        unit: 'runs',
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
        const wins = out.get(answer.question) ?? { variant: 0, control: 0, voted: 0 }
        wins.variant += forward ? t.aWins : t.bWins
        wins.control += forward ? t.bWins : t.aWins
        wins.voted += t.pairs
        out.set(answer.question, wins)
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
  const verdict: MeasureVerdict = same
    ? 'same'
    : lift.verdict === 'lift'
      ? 'better'
      : lift.verdict === 'drop'
        ? 'worse'
        : 'leans'
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
    },
    questions: questionWins(
      paired.map((entry) => ({ entry, variant: lift.variant, control: lift.vs })),
    ),
    family: lift,
  })
}

/**
 * What a comparison says beyond pass rate. `apart`: some measure is better or worse, so the
 * comparison is the result. `leans`: none is, but some measure leans, with the soonest runs (or
 * cases) at which one would hold. `same`: every measure is level, or nothing else was measured.
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
  const soonest = leans
    .filter((m) => m.needed !== null)
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
