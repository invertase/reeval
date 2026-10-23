// What a planned run should cost: each attempt's tokens from the same eval and cell in recent
// history, else a typical coding attempt's, plus its judge calls, as a range. Priced at the list
// prices loaded for the view (prices.ts), or tokens only without them. An estimate for deciding
// whether to run, never a bill: it ignores subscriptions, negotiated prices and retries, and
// leaves out of the dollars any model it has no price for.
import type { RunRecord } from './history/types.ts'
import type { ModelsDev, Price, Prices } from './prices.ts'
import { quantile } from './stats.ts'
import type { Cell, HarnessDescriptor, TokenUsage } from './types.ts'
import { totalTokens } from './usage.ts'

export type Range = { low: number; high: number }
/** Tokens, and USD where every model in it has a price; `usd` is null otherwise. */
export type CostPart = { tokens: Range; usd: Range | null }

/** Where a cell's agent tokens came from: its own past attempts, a typical attempt, or none. */
export type CostBasis = 'history' | 'typical' | 'free'

export type PlanCostCell = {
  eval: string
  cell: string
  /** The model its attempts are priced as; null for the fake agent. */
  model: string | null
  /** The model its judge calls are priced as; null when it makes none, or for the fake judge. */
  judgeModel: string | null
  attempts: number
  basis: CostBasis
  /** Past attempts whose tokens it's based on, when `basis` is `history`. */
  samples: number
  /** Over all its attempts. */
  agent: CostPart
  judge: CostPart
}

export type PlanCost = {
  /** Agent and judge tokens over every attempt. */
  tokens: Range
  /** USD over the parts with a price; null when none has one, or there are no prices. */
  usd: Range | null
  agent: CostPart
  judge: CostPart
  /** Tokens left out of `usd` for want of a price. */
  unpricedTokens: Range
  /** Planned attempts by where their tokens came from. */
  attempts: Record<CostBasis, number>
  /** Recorded runs, and attempts in them, whose tokens fed the estimate. */
  pastRuns: number
  pastAttempts: number
  /** Models with no price in the loaded prices, and their tokens, which `usd` leaves out. */
  unpriced: { model: string; tokens: Range }[]
  /**
   * Where the prices came from: models.dev (or why not), under the `REEVAL_PRICES` file's; or why
   * there are none. Never stored in a record.
   */
  prices: { modelsDev: ModelsDev; file: string | null } | { why: string }
  cells: PlanCostCell[]
}

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
 * A model's price by its id, as written (`anthropic/claude-sonnet-4.5`) or without its
 * `provider/` prefix, without `[param=…]` labels or a trailing effort
 * (`gemini-3.8-flash-medium`); null when `table` has no exact match.
 */
export function priceFor(model: string, table: Record<string, Price>): Price | null {
  let id = model.toLowerCase().replace(/\[.*\]$/, '')
  for (;;) {
    const price = table[id] ?? table[id.slice(id.lastIndexOf('/') + 1)]
    if (price) return price
    const shorter = id.replace(EFFORT_SUFFIX, '')
    if (shorter === id) return null
    id = shorter
  }
}

/** `output` already counts the reasoning tokens, which are billed as output. */
export const usdOf = (t: Tokens, [input, cacheRead, cacheWrite, output]: Price) =>
  (t.input * input + t.cacheRead * cacheRead + t.cacheWrite * cacheWrite + t.output * output) / 1e6

const tokensOf = (t: Tokens) => totalTokens({ reasoning: null, ...t })

/** The model a harness's attempts are billed as; null for the fake agent, which costs nothing. */
export function harnessModel(h: HarnessDescriptor): string | null {
  if (h.kind === 'fake') return null
  if (h.kind === 'cursor' && h.params?.fast === 'true') return `${h.model}-fast`
  return h.model
}

/** Whether the plan has anything to price: a real agent, or a judge that isn't the fake one. */
export const needsPrices = (harnesses: HarnessDescriptor[], judgeModel: string | null) =>
  harnesses.some((h) => h.kind !== 'fake') || (judgeModel !== null && judgeModel !== 'fake')

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

const ZERO: Range = { low: 0, high: 0 }
const scale = (r: Range, n: number): Range => ({ low: r.low * n, high: r.high * n })
const add = (a: Range, b: Range): Range => ({ low: a.low + b.low, high: a.high + b.high })
const addOrNull = (a: Range | null, b: Range | null): Range | null =>
  a && b ? add(a, b) : (a ?? b)
const scalePart = (p: CostPart, n: number): CostPart => ({
  tokens: scale(p.tokens, n),
  usd: p.usd && scale(p.usd, n),
})
const round = (r: Range | null, digits: number): Range | null =>
  r && {
    low: Math.round(r.low * 10 ** digits) / 10 ** digits,
    high: Math.round(r.high * 10 ** digits) / 10 ** digits,
  }
const roundPart = (p: CostPart): CostPart => ({
  tokens: round(p.tokens, 0) as Range,
  usd: round(p.usd, 4),
})

/** A range around past values: their middle half, never narrower than -20%/+25% of the median. */
function rangeOf(values: number[]): Range {
  const median = quantile(values, 0.5) ?? 0
  return {
    low: Math.min(quantile(values, 0.25) ?? 0, median * 0.8),
    high: Math.max(quantile(values, 0.75) ?? 0, median * 1.25),
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
  prices: Prices,
): PlanCost {
  const history = indexHistory(records)
  const table = prices.table
  const cells = new Map<string, PlanCostCell>()
  const used = new Map<string, string>()
  const overlay = prices.table ? prices.overlay : null
  const priced = (model: string) =>
    table && ((overlay && priceFor(model, overlay)) ?? priceFor(model, table))
  const judgeOf = (id: string): { part: CostPart; model: string | null } => {
    const past = history.judges.get(id)
    const calls = past?.length
      ? (quantile(
          past.map((j) => j.calls),
          0.5,
        ) ?? 0)
      : null
    const model = past?.length ? mostCommon(past.flatMap((j) => j.models)) : judgeModel
    if (calls === 0 || !model || model === 'fake') {
      return { part: { tokens: ZERO, usd: table && ZERO }, model: null }
    }
    const price = priced(model)
    const { low, high } = TYPICAL_JUDGE_CALL
    const call: CostPart = {
      tokens: { low: tokensOf(low), high: tokensOf(high) },
      usd: price && { low: usdOf(low, price), high: usdOf(high, price) },
    }
    if (calls !== null) return { part: scalePart(call, calls), model }
    return {
      part: {
        tokens: { low: 0, high: call.tokens.high },
        usd: call.usd && { low: 0, high: call.usd.high },
      },
      model,
    }
  }
  for (const { id, cell, harness } of attempts) {
    const key = `${id}\0${cell.key}`
    let c = cells.get(key)
    if (!c) {
      const model = harnessModel(harness)
      const samples = history.byCell.get(key) ?? history.byHarness.get(`${id}\0${cell.harness}`)
      const basis: CostBasis = !model ? 'free' : samples?.length ? 'history' : 'typical'
      const price = model ? priced(model) : null
      let agent: CostPart = { tokens: ZERO, usd: table && ZERO }
      if (basis === 'history' && samples) {
        for (const s of samples) used.set(`${s.runId}\0${s.key}`, s.runId)
        agent = {
          tokens: rangeOf(samples.map((s) => totalTokens(s.usage))),
          usd: price && rangeOf(samples.map((s) => usdOf(s.usage, price))),
        }
      } else if (basis === 'typical') {
        const { low, high } = TYPICAL_ATTEMPT
        agent = {
          tokens: { low: tokensOf(low), high: tokensOf(high) },
          usd: price && { low: usdOf(low, price), high: usdOf(high, price) },
        }
      }
      const judge = judgeOf(id)
      c = {
        eval: id,
        cell: cell.key,
        model,
        judgeModel: judge.model,
        attempts: 0,
        basis,
        samples: basis === 'history' ? (samples?.length ?? 0) : 0,
        agent,
        judge: judge.part,
      }
      cells.set(key, c)
    }
    c.attempts++
  }
  const list = [...cells.values()].map((c) => ({
    ...c,
    agent: scalePart(c.agent, c.attempts),
    judge: scalePart(c.judge, c.attempts),
  }))
  const sum = (part: (c: PlanCostCell) => CostPart): CostPart => ({
    tokens: list.reduce((t, c) => add(t, part(c).tokens), ZERO),
    usd: list.reduce<Range | null>((t, c) => addOrNull(t, part(c).usd), null),
  })
  const agent = sum((c) => c.agent)
  const judge = sum((c) => c.judge)
  const unpricedTokens = list.reduce(
    (t, c) => add(add(t, c.agent.usd ? ZERO : c.agent.tokens), c.judge.usd ? ZERO : c.judge.tokens),
    ZERO,
  )
  const unpriced = new Map<string, Range>()
  const leftOut = (model: string | null, part: CostPart) => {
    if (table && model && !part.usd && part.tokens.high > 0) {
      unpriced.set(model, add(unpriced.get(model) ?? ZERO, part.tokens))
    }
  }
  for (const c of list) {
    leftOut(c.model, c.agent)
    leftOut(c.judgeModel, c.judge)
  }
  const tally: Record<CostBasis, number> = { history: 0, typical: 0, free: 0 }
  for (const c of list) tally[c.basis] += c.attempts
  const usd = addOrNull(agent.usd, judge.usd)
  return {
    tokens: round(add(agent.tokens, judge.tokens), 0) as Range,
    usd: usd && (usd.high > 0 || unpricedTokens.high === 0) ? round(usd, 4) : null,
    agent: roundPart(agent),
    judge: roundPart(judge),
    unpricedTokens: round(unpricedTokens, 0) as Range,
    attempts: tally,
    pastRuns: new Set(used.values()).size,
    pastAttempts: used.size,
    unpriced: [...unpriced]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, tokens]) => ({ model, tokens: round(tokens, 0) as Range })),
    prices: prices.table ? { modelsDev: prices.modelsDev, file: prices.file } : { why: prices.why },
    cells: list.map((c) => ({ ...c, agent: roundPart(c.agent), judge: roundPart(c.judge) })),
  }
}

/** `$0.40–2.10`, `$12–40`, `up to $0.02`, `under $0.01`: the low end rounded down, the high end up. */
export function formatUsdRange({ low, high }: Range): string {
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

/** `0.6–4.2M tokens`, `120–900k tokens`, `up to 62k tokens`. */
export function formatTokenRange({ low, high }: Range): string {
  const [unit, div] = high >= 1e6 ? ['M', 1e6] : ['k', 1e3]
  const digits = unit === 'M' && high < 10e6 ? 1 : 0
  const at = (n: number, round: (n: number) => number) =>
    (round((n / div) * 10 ** digits) / 10 ** digits).toFixed(digits)
  const [lo, hi] = [at(low, Math.floor), at(high, Math.ceil)]
  if (Number(lo) === 0) return `up to ${hi}${unit} tokens`
  return lo === hi ? `about ${hi}${unit} tokens` : `${lo}–${hi}${unit} tokens`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * `models.dev list prices`, `models.dev list prices of 2026-10-20 (offline)` from an old copy,
 * `prices.json over models.dev list prices` with a `REEVAL_PRICES` file, or
 * `prices.json (models.dev unreachable, …)` when it's the file alone.
 */
function priceLabel({ modelsDev, file }: { modelsDev: ModelsDev; file: string | null }) {
  if ('why' in modelsDev) return `${file} (${modelsDev.why})`
  const list = `models.dev list prices${modelsDev.stale ? ` of ${modelsDev.fetchedAt.slice(0, 10)} (offline)` : ''}`
  return file ? `${file} over ${list}` : list
}

/** What a partly priced estimate's dollars cover: `judge only`, `claude-sonnet-5, judge`. */
function covered(c: PlanCost): string {
  const agents = [
    ...new Set(
      c.cells.filter((x) => x.model && x.agent.usd && x.agent.tokens.high > 0).map((x) => x.model),
    ),
  ]
  const judged = c.cells.some((x) => x.judge.usd && x.judge.tokens.high > 0)
  if (!agents.length) return 'judge only'
  return judged ? `${agents.join(', ')}, judge` : `${agents.join(', ')} only`
}

/**
 * `cost  estimated $3.10–8.40 at models.dev list prices, judge included · from 4 past runs`; with
 * models it has no price for, `$0.06 priced (judge only) at …; composer-2.5: 0.3–2.1M tokens, no
 * list price`; or tokens alone without prices. Null when every attempt is the fake agent's, which
 * costs nothing.
 */
export function costLine(c: PlanCost): string | null {
  if (c.tokens.high === 0 && (c.usd === null || c.usd.high === 0)) return null
  const judged = c.judge.tokens.high > 0 ? ', judge included' : ''
  const parts: string[] = []
  if (c.usd && !('why' in c.prices)) {
    const usd = formatUsdRange(c.usd)
    const label = priceLabel(c.prices)
    if (c.unpricedTokens.high === 0) {
      parts.push(`estimated ${usd} at ${label}${judged}`)
    } else {
      const left = c.unpriced.map((u) => `${u.model}: ${formatTokenRange(u.tokens)}`).join(', ')
      parts.push(`${usd} priced (${covered(c)}) at ${label}; ${left}, no list price`)
    }
  } else {
    parts.push(`estimated ${formatTokenRange(c.tokens)}${judged}`)
    parts.push(
      'why' in c.prices
        ? `no prices: ${c.prices.why}`
        : `no list price for ${c.unpriced.map((u) => u.model).join(', ')}`,
    )
  }
  const { history, typical } = c.attempts
  const runs = plural(c.pastRuns, 'past run')
  if (typical === 0 && history > 0) parts.push(`from ${runs}`)
  else if (history === 0) parts.push('no history, rough')
  else parts.push(`${history} of ${history + typical} attempts from ${runs}, the rest rough`)
  return `cost  ${parts.join(' · ')}`
}
