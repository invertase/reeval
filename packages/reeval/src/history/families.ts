// A pooled `evaluate.each` as one suite: each cell's pass@1 over the cases and, with
// `compare`, each variant's lift over the control paired by case. A case is the unit: at one
// attempt a case and side that's a Bernoulli pair (Newcombe's paired interval, McNemar's exact
// test); at several, a t interval over the cases' pass@1 differences, so attempts within a case
// are never counted as independent.
import {
  containsZero,
  mcnemar,
  meanInterval,
  median,
  PAIRED_MIN,
  type PairCounts,
  pairedLiftInterval,
  round3,
  signedRank,
  wilson,
} from '../stats.ts'
import { EFFORT_ALPHA, type EffortSample, effortSample } from '../view/effort.ts'
import type {
  AttemptRecord,
  CellRecord,
  EvalEntry,
  FamilyEffort,
  FamilyEffortMetric,
  FamilyInterval,
  FamilyLift,
  FamilyRate,
  FamilyRecord,
} from './types.ts'

const isCounted = (a: AttemptRecord) => a.outcome === 'pass' || a.outcome === 'fail'

type Side = { pass: number; counted: number; samples: EffortSample[] }

function sideOf(entry: EvalEntry, cell: string): Side | null {
  const counted = entry.attempts.filter((a) => a.cell === cell && isCounted(a))
  if (!counted.length) return null
  return {
    pass: counted.filter((a) => a.outcome === 'pass').length,
    counted: counted.length,
    samples: counted.map(effortSample),
  }
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

const interval = (
  lo: number,
  hi: number,
  method: FamilyInterval['method'],
  bound: [number, number],
): FamilyInterval => ({
  lo: round3(clamp(lo, ...bound)),
  hi: round3(clamp(hi, ...bound)),
  level: 0.95,
  method,
})

function rateOf(cell: string, sides: Side[]): FamilyRate {
  const pass = sides.reduce((s, x) => s + x.pass, 0)
  const counted = sides.reduce((s, x) => s + x.counted, 0)
  const single = sides.every((x) => x.counted === 1)
  const rates = sides.map((x) => x.pass / x.counted)
  const t = meanInterval(rates)
  const w = wilson(pass, counted)
  return {
    cell,
    cases: sides.length,
    pass,
    counted,
    rate: round3(t.mean),
    interval: single
      ? interval(w.low, w.high, 'wilson', [0, 1])
      : interval(t.low, t.high, 't-cases', [0, 1]),
  }
}

function metric(pairs: Array<[number, number]>): FamilyEffortMetric {
  const differences = pairs.map(([v, c]) => v - c)
  const control = median(pairs.map(([, c]) => c)) ?? 0
  const variant = median(pairs.map(([v]) => v)) ?? 0
  const p = signedRank(differences)
  const nonZero = differences.filter((d) => d !== 0).length
  const verdict =
    nonZero < PAIRED_MIN
      ? 'insufficient'
      : p === null || p >= EFFORT_ALPHA
        ? 'noise'
        : (median(differences) ?? 0) < 0
          ? 'fewer'
          : 'more'
  return {
    pairs: pairs.length,
    ratio: control === 0 ? null : round3(variant / control),
    p: p === null ? null : round3(p),
    verdict,
  }
}

function effortOf(pairs: Array<[Side, Side]>): FamilyEffort {
  const per = (pick: (s: EffortSample) => number | undefined) =>
    pairs.flatMap(([v, c]): Array<[number, number]> => {
      const vs = v.samples.map(pick)
      const cs = c.samples.map(pick)
      if (!vs.every((x) => x !== undefined) || !cs.every((x) => x !== undefined)) return []
      return [[median(vs) ?? 0, median(cs) ?? 0]]
    })
  const tokens = per((s) => s.tokens)
  return {
    tools: metric(per((s) => s.tools)),
    agentMs: metric(per((s) => s.agentMs)),
    ...(tokens.length ? { tokens: metric(tokens) } : {}),
  }
}

function liftOf(
  variant: string,
  control: string,
  cases: EvalEntry[],
  minLift: number | undefined,
): FamilyLift | null {
  const pairs = cases.flatMap((e): Array<[Side, Side]> => {
    const v = sideOf(e, variant)
    const c = sideOf(e, control)
    return v && c ? [[v, c]] : []
  })
  if (!pairs.length) return null
  const single = pairs.every(([v, c]) => v.counted === 1 && c.counted === 1)
  const vRates = pairs.map(([v]) => v.pass / v.counted)
  const cRates = pairs.map(([, c]) => c.pass / c.counted)
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
  let points: number
  let range: FamilyInterval
  let p: number | null
  let discordant: FamilyLift['discordant']
  let decided: boolean
  if (single) {
    const counts: PairCounts = { both: 0, variantOnly: 0, controlOnly: 0, neither: 0 }
    for (const [v, c] of pairs) {
      if (v.pass && c.pass) counts.both++
      else if (v.pass) counts.variantOnly++
      else if (c.pass) counts.controlOnly++
      else counts.neither++
    }
    const paired = pairedLiftInterval(counts)
    points = paired.points
    range = interval(paired.low, paired.high, 'newcombe-paired', [-1, 1])
    p = round3(mcnemar(counts.variantOnly, counts.controlOnly))
    discordant = { variantOnly: counts.variantOnly, controlOnly: counts.controlOnly }
    decided = counts.variantOnly + counts.controlOnly >= PAIRED_MIN
  } else {
    const differences = vRates.map((r, i) => r - (cRates[i] as number))
    const t = meanInterval(differences)
    points = t.mean
    range = interval(t.low, t.high, 't-cases', [-1, 1])
    const rank = signedRank(differences)
    p = rank === null ? null : round3(rank)
    decided = pairs.length >= PAIRED_MIN
  }
  const verdict = !decided
    ? 'insufficient'
    : range.lo > 0
      ? 'lift'
      : range.hi < 0
        ? 'drop'
        : 'noise'
  return {
    variant,
    vs: control,
    pairs: pairs.length,
    variantRate: round3(mean(vRates)),
    controlRate: round3(mean(cRates)),
    ...(discordant ? { discordant } : {}),
    points: round3(points),
    interval: range,
    p,
    withinNoise: containsZero(range.lo, range.hi),
    verdict,
    ...(minLift !== undefined ? { minLift } : {}),
    outcome: minLift !== undefined && range.lo < minLift ? 'fail' : 'pass',
    effort: effortOf(pairs),
  }
}

/**
 * The run's pooled families, in the order their first case appears; `minLiftOf` gives a variant
 * cell's `compare.minLift`.
 */
export function familiesOf(
  evals: EvalEntry[],
  minLiftOf: (cell: CellRecord) => number | undefined,
): FamilyRecord[] {
  const byId = new Map<string, EvalEntry[]>()
  for (const e of evals) {
    if (!e.family || e.todo) continue
    byId.set(e.family.id, [...(byId.get(e.family.id) ?? []), e])
  }
  return [...byId.values()].map((members) => {
    const cases = [...members].sort((a, b) => (a.family?.case ?? 0) - (b.family?.case ?? 0))
    const first = cases[0] as EvalEntry
    const family = first.family as NonNullable<EvalEntry['family']>
    const cellKeys: string[] = []
    for (const e of cases)
      for (const c of e.cells) if (!cellKeys.includes(c.key)) cellKeys.push(c.key)
    const rates = cellKeys.flatMap((key) => {
      const sides = cases.flatMap((e) => sideOf(e, key) ?? [])
      return sides.length ? [rateOf(key, sides)] : []
    })
    const lifts: FamilyLift[] = []
    for (const key of cellKeys) {
      const holder = cases.find((e) => e.cells.some((c) => c.key === key && c.role === 'variant'))
      const variant = holder?.cells.find((c) => c.key === key)
      if (!holder || !variant) continue
      const control = holder.cells.find(
        (c) =>
          c.role === 'control' && c.harness === variant.harness && c.sandbox === variant.sandbox,
      )
      if (!control) continue
      const minLift = cases
        .flatMap((e) => e.cells.filter((c) => c.key === key))
        .map(minLiftOf)
        .find((m) => m !== undefined)
      const lift = liftOf(key, control.key, cases, minLift)
      if (lift) lifts.push(lift)
    }
    return {
      id: family.id,
      file: first.file,
      group: first.group,
      name: family.name,
      cases: family.cases,
      ran: cases.length,
      rates,
      lifts,
      outcome: lifts.some((l) => l.outcome === 'fail') ? 'fail' : 'pass',
    }
  })
}
