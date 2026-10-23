// What a planned run should cost, as a range at list prices: each attempt's tokens from the same
// eval and cell in recent history, else a typical coding attempt's, priced from the dated table in
// prices.ts, plus its judge calls. An estimate for deciding whether to run, never a bill: it
// ignores subscriptions, negotiated prices and retries, and leaves out models it has no price for.
import type { RunRecord } from './history/types.ts'
import { PRICES, PRICES_DATE, PRICES_SOURCE } from './prices.ts'
import { quantile } from './stats.ts'
import type { Cell, HarnessDescriptor, TokenUsage } from './types.ts'

export type UsdRange = { low: number; high: number }

/** Where a cell's agent tokens came from: its own past attempts, a typical attempt, or neither. */
export type CostBasis = 'history' | 'typical' | 'unpriced' | 'free'

export type PlanCostCell = {
  eval: string
  cell: string
  /** The model its attempts are priced as; null for the fake agent. */
  model: string | null
  attempts: number
  basis: CostBasis
  /** Past attempts whose tokens priced it, when `basis` is `history`. */
  samples: number
  /** Over all its attempts; null when unpriced. */
  agent: UsdRange | null
  /** Its attempts' judge calls; null when the judge has no price. */
  judge: UsdRange | null
}

export type PlanCost = {
  /** Agent and judge together, in USD at list prices; null when nothing could be priced. */
  usd: UsdRange | null
  agent: UsdRange | null
  judge: UsdRange | null
  /** Planned attempts by where their tokens came from. */
  attempts: Record<CostBasis, number>
  /** Recorded runs, and attempts in them, whose tokens fed the estimate. */
  pastRuns: number
  pastAttempts: number
  /** Models left out for want of a list price. */
  unpriced: { agent: string[]; judge: string[] }
  prices: { date: string; source: string }
  cells: PlanCostCell[]
}

type Price = readonly [number, number, number, number]
type Tokens = Pick<TokenUsage, 'input' | 'cacheRead' | 'cacheWrite' | 'output'> & {
  reasoning?: number | null
}

/**
 * A medium coding attempt re-sends its context on every step, mostly from cache: about 300k
 * prompt tokens at the low end and 2M at the high, against a median of about 1M over real ones.
 */
export const TYPICAL_ATTEMPT: { low: Tokens; high: Tokens } = {
  low: { input: 15_000, cacheRead: 285_000, cacheWrite: 0, output: 3_000 },
  high: { input: 100_000, cacheRead: 1_900_000, cacheWrite: 0, output: 20_000 },
}

/** One judge call: 5–60k tokens of task, output, diff and files in, a short verdict out. */
export const TYPICAL_JUDGE_CALL: { low: Tokens; high: Tokens } = {
  low: { input: 5_000, cacheRead: 0, cacheWrite: 0, output: 500 },
  high: { input: 60_000, cacheRead: 0, cacheWrite: 0, output: 2_000 },
}

const EFFORT_SUFFIX = /-(none|minimal|low|medium|high|xhigh|max|thinking)$/

/**
 * A model's list price by its id, without a `provider/` prefix, `[param=…]` labels or a trailing
 * effort (`gemini-3.8-flash-medium`); null when the table has no exact match.
 */
export function priceOf(model: string): Price | null {
  let id = model.toLowerCase().replace(/\[.*\]$/, '')
  id = id.slice(id.lastIndexOf('/') + 1)
  for (;;) {
    const price = PRICES[id]
    if (price) return price
    const shorter = id.replace(EFFORT_SUFFIX, '')
    if (shorter === id) return null
    id = shorter
  }
}

/** Reasoning tokens are billed as output. */
export const usdOf = (t: Tokens, [input, cacheRead, cacheWrite, output]: Price) =>
  (t.input * input +
    t.cacheRead * cacheRead +
    t.cacheWrite * cacheWrite +
    (t.output + (t.reasoning ?? 0)) * output) /
  1e6

/** The model a harness's attempts are billed as; null for the fake agent, which costs nothing. */
export function harnessModel(h: HarnessDescriptor): string | null {
  if (h.kind === 'fake') return null
  if (h.kind === 'cursor' && h.params?.fast === 'true') return `${h.model}-fast`
  return h.model
}

const isFreeModel = (model: string) => model === 'fake'

type Sample = { usage: TokenUsage; key: string; runId: string }
type JudgeSample = { calls: number; models: string[] }

const counted = (outcome: string) => outcome === 'pass' || outcome === 'fail'

/** Past attempts' usage by eval and cell, and by eval and harness, and judge calls by eval. */
function indexHistory(records: RunRecord[]) {
  const byCell = new Map<string, Sample[]>()
  const byHarness = new Map<string, Sample[]>()
  const judges = new Map<string, JudgeSample[]>()
  const push = <T>(map: Map<string, T[]>, key: string, value: T) =>
    map.set(key, [...(map.get(key) ?? []), value])
  for (const record of records) {
    for (const e of record.evals ?? []) {
      for (const a of e.attempts ?? []) {
        if (!counted(a.outcome)) continue
        push(judges, e.id, {
          calls: a.judgements?.length ?? 0,
          models: (a.judgements ?? []).map((j) => j.model),
        })
        if (!a.usage) continue
        const sample = { usage: a.usage, key: a.key, runId: record.runId }
        push(byCell, `${e.id}\0${a.cell}`, sample)
        const harness = e.cells?.find((c) => c.key === a.cell)?.harness
        if (harness) push(byHarness, `${e.id}\0${harness}`, sample)
      }
    }
  }
  return { byCell, byHarness, judges }
}

const scale = (r: UsdRange, n: number): UsdRange => ({ low: r.low * n, high: r.high * n })
const round = (r: UsdRange | null): UsdRange | null =>
  r && { low: Math.round(r.low * 1e4) / 1e4, high: Math.round(r.high * 1e4) / 1e4 }
const add = (a: UsdRange | null, b: UsdRange | null): UsdRange | null =>
  a && b ? { low: a.low + b.low, high: a.high + b.high } : (a ?? b)

/** A range around past costs: their middle half, and never narrower than -20%/+25% of the median. */
function rangeOf(costs: number[]): UsdRange {
  const median = quantile(costs, 0.5) ?? 0
  return {
    low: Math.min(quantile(costs, 0.25) ?? 0, median * 0.8),
    high: Math.max(quantile(costs, 0.75) ?? 0, median * 1.25),
  }
}

const mostCommon = (values: string[]) => {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}

export type CostedAttempt = { id: string; cell: Cell; harness: HarnessDescriptor }

/**
 * The plan's cost. `judgeModel` is the run's judge (`fake` for a fake judge, null for none): an
 * eval with no history is assumed to call it 0 or 1 times an attempt; one with history, as many
 * times as its past attempts did, on the model they used.
 */
export function planCost(
  attempts: CostedAttempt[],
  records: RunRecord[],
  judgeModel: string | null,
): PlanCost {
  const history = indexHistory(records)
  const cells = new Map<string, PlanCostCell>()
  const used = new Map<string, string>()
  const unpriced = { agent: new Set<string>(), judge: new Set<string>() }
  const judgeOf = (id: string): UsdRange | null => {
    const past = history.judges.get(id)
    const calls = past?.length
      ? (quantile(
          past.map((j) => j.calls),
          0.5,
        ) ?? 0)
      : null
    if (calls === 0) return { low: 0, high: 0 }
    const model = past?.length ? mostCommon(past.flatMap((j) => j.models)) : judgeModel
    if (!model || isFreeModel(model)) return { low: 0, high: 0 }
    const price = priceOf(model)
    if (!price) {
      unpriced.judge.add(model)
      return null
    }
    const call = {
      low: usdOf(TYPICAL_JUDGE_CALL.low, price),
      high: usdOf(TYPICAL_JUDGE_CALL.high, price),
    }
    return calls === null ? { low: 0, high: call.high } : scale(call, calls)
  }
  for (const { id, cell, harness } of attempts) {
    const key = `${id}\0${cell.key}`
    let c = cells.get(key)
    if (!c) {
      const model = harnessModel(harness)
      const price = model ? priceOf(model) : null
      const samples = history.byCell.get(key) ?? history.byHarness.get(`${id}\0${cell.harness}`)
      const basis: CostBasis = !model
        ? 'free'
        : !price
          ? 'unpriced'
          : samples?.length
            ? 'history'
            : 'typical'
      if (model && !price) unpriced.agent.add(model)
      if (basis === 'history')
        for (const s of samples ?? []) used.set(`${s.runId}\0${s.key}`, s.runId)
      c = {
        eval: id,
        cell: cell.key,
        model,
        attempts: 0,
        basis,
        samples: basis === 'history' ? (samples?.length ?? 0) : 0,
        agent:
          basis === 'free'
            ? { low: 0, high: 0 }
            : !price
              ? null
              : basis === 'history'
                ? rangeOf((samples ?? []).map((s) => usdOf(s.usage, price)))
                : {
                    low: usdOf(TYPICAL_ATTEMPT.low, price),
                    high: usdOf(TYPICAL_ATTEMPT.high, price),
                  },
        judge: judgeOf(id),
      }
      cells.set(key, c)
    }
    c.attempts++
  }
  const list = [...cells.values()].map((c) => ({
    ...c,
    agent: c.agent && scale(c.agent, c.attempts),
    judge: c.judge && scale(c.judge, c.attempts),
  }))
  const tally: Record<CostBasis, number> = { history: 0, typical: 0, unpriced: 0, free: 0 }
  for (const c of list) tally[c.basis] += c.attempts
  const agent = list
    .filter((c) => c.basis === 'history' || c.basis === 'typical')
    .reduce<UsdRange | null>((sum, c) => add(sum, c.agent), null)
  const judge = list.reduce<UsdRange | null>(
    (sum, c) => (c.judge && c.judge.high > 0 ? add(sum, c.judge) : sum),
    null,
  )
  return {
    usd: round(add(agent, judge)),
    agent: round(agent),
    judge: round(judge),
    attempts: tally,
    pastRuns: new Set(used.values()).size,
    pastAttempts: used.size,
    unpriced: { agent: [...unpriced.agent].sort(), judge: [...unpriced.judge].sort() },
    prices: { date: PRICES_DATE, source: PRICES_SOURCE },
    cells: list.map((c) => ({ ...c, agent: round(c.agent), judge: round(c.judge) })),
  }
}

/** `$0.40–2.10`, `$12–40`, `up to $0.02`, `under $0.01`: the low end rounded down, the high end up. */
export function formatUsdRange({ low, high }: UsdRange): string {
  if (high < 0.01) return 'under $0.01'
  const digits = high < 10 ? 2 : 0
  const at = (n: number, round: (n: number) => number) => {
    const v = round(n * 10 ** digits) / 10 ** digits
    return digits ? v.toFixed(digits) : v.toLocaleString('en-US')
  }
  const [lo, hi] = [at(low, Math.floor), at(high, Math.ceil)]
  if (Number(lo) === 0) return `up to $${hi}`
  return lo === hi ? `about $${hi}` : `$${lo}–${hi}`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * `cost  estimated $3.10–8.40 at list prices, judge included · from 4 past runs`; null when
 * every attempt is the fake agent's, which costs nothing.
 */
export function costLine(c: PlanCost): string | null {
  const parts: string[] = []
  if (c.usd) {
    const judged = c.judge && c.judge.high > 0 ? ', judge included' : ''
    parts.push(`estimated ${formatUsdRange(c.usd)} at list prices${judged}`)
    const { history, typical } = c.attempts
    const runs = plural(c.pastRuns, 'past run')
    if (typical === 0 && history > 0) parts.push(`from ${runs}`)
    else if (history === 0) parts.push('no history, rough')
    else parts.push(`${history} of ${history + typical} attempts from ${runs}, the rest rough`)
  }
  if (c.unpriced.agent.length) {
    parts.push(
      `${plural(c.attempts.unpriced, 'attempt')} left out: no list price for ${c.unpriced.agent.join(', ')}`,
    )
  }
  if (c.unpriced.judge.length) {
    parts.push(`judge left out: no list price for ${c.unpriced.judge.join(', ')}`)
  }
  return parts.length ? `cost  ${parts.join(' · ')}` : null
}
