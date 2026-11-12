// Effort next to lift: tool calls, agent time, tokens and cost per cell, and a variant's against
// its control. Pass rate can't tell a skill that makes the agent 4× cheaper from no skill at
// all when both pass, so effort is reported with its own test and verdict.
import type { AttemptRecord, EvalEntry } from '../history/types.ts'
import { mannWhitney, median, minimumP, quantile } from '../stats.ts'
import type { TimeSplit } from '../types.ts'
import { formatTokens, totalTokens } from '../usage.ts'
import { formatUsd } from './cost.ts'

/** Below this two-sided p, an effort difference is an effect. */
export const EFFORT_ALPHA = 0.05

/** Some counted attempts reported no usage. Not a verdict; never printed as one. */
export const TOKENS_UNREPORTED = 'some cells did not report usage'

export type EffortSample = {
  tools: number
  agentMs: number
  /** Calls to the agent's file-editing tools (`activity.fileEdits`). */
  fileEdits: number
  /** Files the workspace diff changed, however the agent changed them. */
  filesChanged: number
  /** Total tokens when this attempt reported usage; omitted when the harness dropped it. */
  tokens?: number
  /** Where its agent time went; omitted for an attempt recorded without it. */
  split?: TimeSplit
  /** The agent's cost in US dollars (`cost.usd`); omitted when the attempt has none. */
  usd?: number
}
type Spread = { median: number; q1: number; q3: number }
/** One cell's effort over its counted attempts (passes and fails; infra errors and skips aren't). */
export type CellEffort = {
  n: number
  tools: Spread
  agentMs: Spread
  /** Median file edits: edit tool calls, not the files the diff changed (`filesChanged`). */
  fileEdits: number
  /** Median files the workspace diff changed. */
  filesChanged: number
  /** Over the counted attempts that reported usage; omitted when none did. */
  tokens?: Spread
  /**
   * Median model, tool, waiting and other time over the counted attempts that have a split;
   * omitted when none does. `modelMs` is null when any of them saw no model calls.
   */
  split?: TimeSplit
  /** The agent's cost in US dollars over the counted attempts that have one; omitted when none does. */
  usd?: Spread
}

/**
 * `fewer` / `more`: the exact rank test's p is below `EFFORT_ALPHA`. `noise`: it isn't.
 * `insufficient`: too few attempts for the test to ever reach it (2 against 2 can't). Never
 * means a harness dropped usage.
 */
export type EffortVerdict = 'fewer' | 'more' | 'noise' | 'insufficient'

export type EffortContrast = {
  variant: CellEffort
  control: CellEffort
  /** Variant median over control median; null when the control's is 0. */
  toolsRatio: number | null
  agentMsRatio: number | null
  agentMsDelta: number
  toolsP: number | null
  agentMsP: number | null
  /** The variant's and control's tool-call ranges don't overlap. */
  separated: boolean
  /** Their agent-time ranges don't overlap. */
  timeSeparated: boolean
  /** Their token ranges don't overlap; null when the token test was omitted. */
  tokensSeparated: boolean | null
  /** On tool calls, the steadier measure; `timeVerdict` on agent time. */
  verdict: EffortVerdict
  timeVerdict: EffortVerdict
  /**
   * Token medians' ratio when both sides have at least one usage sample; null when the
   * control's is 0 or the token test was omitted.
   */
  tokensRatio: number | null
  tokensP: number | null
  /**
   * Rank-test verdict on the attempts that reported usage. Null when either side has no
   * token sample — omitted, not `insufficient`.
   */
  tokensVerdict: EffortVerdict | null
  /** Set when some counted attempts on either side reported no usage. Not a verdict. */
  tokensNote?: typeof TOKENS_UNREPORTED
}

export const effortSample = (
  a: Pick<AttemptRecord, 'activity' | 'timings' | 'usage' | 'changedFiles' | 'timeSplit' | 'cost'>,
): EffortSample => ({
  tools: a.activity.tools,
  agentMs: a.timings.agentMs,
  fileEdits: a.activity.fileEdits,
  filesChanged: filesChanged(a.changedFiles),
  ...(a.usage ? { tokens: totalTokens(a.usage) } : {}),
  ...(a.timeSplit ? { split: a.timeSplit } : {}),
  ...(a.cost ? { usd: a.cost.usd } : {}),
})

/** The files the workspace diff changed, a collapsed directory counting each of its files. */
export const filesChanged = (files: AttemptRecord['changedFiles']) =>
  files.reduce((n, f) => n + (f.count ?? 1), 0)

const counted = (a: Pick<AttemptRecord, 'outcome'>) => a.outcome === 'pass' || a.outcome === 'fail'

const spread = (values: number[]): Spread => ({
  median: median(values) ?? 0,
  q1: quantile(values, 0.25) ?? 0,
  q3: quantile(values, 0.75) ?? 0,
})

/** Token totals from the attempts that reported usage; empty when none did. */
export const tokenValues = (samples: EffortSample[]): number[] =>
  samples.flatMap((s) => (s.tokens === undefined ? [] : [s.tokens]))

/** The samples' median split, `modelMs` null when any sample's is; undefined when none has one. */
export function splitOf(samples: EffortSample[]): TimeSplit | undefined {
  const splits = samples.flatMap((s) => (s.split ? [s.split] : []))
  if (splits.length === 0) return undefined
  const mid = (f: (s: TimeSplit) => number) => median(splits.map(f)) ?? 0
  return {
    modelMs: splits.every((s) => s.modelMs !== null) ? mid((s) => s.modelMs ?? 0) : null,
    toolMs: mid((s) => s.toolMs),
    waitingMs: mid((s) => s.waitingMs),
    otherMs: mid((s) => s.otherMs),
  }
}

export function effortOf(samples: EffortSample[]): CellEffort | null {
  if (samples.length === 0) return null
  const tokens = tokenValues(samples)
  const split = splitOf(samples)
  const usd = samples.flatMap((s) => (s.usd === undefined ? [] : [s.usd]))
  return {
    n: samples.length,
    tools: spread(samples.map((s) => s.tools)),
    agentMs: spread(samples.map((s) => s.agentMs)),
    fileEdits: median(samples.map((s) => s.fileEdits)) ?? 0,
    filesChanged: median(samples.map((s) => s.filesChanged)) ?? 0,
    ...(tokens.length ? { tokens: spread(tokens) } : {}),
    ...(split ? { split } : {}),
    ...(usd.length ? { usd: spread(usd) } : {}),
  }
}

/**
 * The verdict of an exact rank test of `xs` (variant) against `ys` (control). Its direction is
 * the test's (which side ranks lower), not the medians', which can be equal or disagree.
 */
export function effortVerdict(
  xs: number[],
  ys: number[],
): { p: number | null; verdict: EffortVerdict } {
  const test = mannWhitney(xs, ys)
  const p = test?.p ?? null
  if (test === null || test.floor >= EFFORT_ALPHA) return { p, verdict: 'insufficient' }
  if (test.p >= EFFORT_ALPHA) return { p, verdict: 'noise' }
  return { p, verdict: test.sign < 0 ? 'fewer' : 'more' }
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b)

/** Every value on one side is below every value on the other. */
const apart = (xs: number[], ys: number[]) =>
  Math.max(...xs) < Math.min(...ys) || Math.min(...xs) > Math.max(...ys)

/**
 * The fewest attempts a side for "no overlap" to say anything: at 3 against 3 one ordering in
 * ten separates by chance; at 1 against 1 every pair of unequal values does.
 */
export const DIRECTIONAL_MIN = 3

/**
 * The fewest runs per cell whose effort test can reach `EFFORT_ALPHA` (4 against 4: p = 2/70).
 */
export const EFFORT_MIN_RUNS = (() => {
  let n = 1
  while (minimumP(n, n) >= EFFORT_ALPHA) n++
  return n
})()

export type EffortMetric = 'tools' | 'agentS' | 'tokens'

/**
 * The metrics whose test is `insufficient` but whose ranges don't overlap at
 * `DIRECTIONAL_MIN` a side or more: a direction, not an effect.
 */
export function directional(c: EffortContrast): EffortMetric[] {
  if (Math.min(c.variant.n, c.control.n) < DIRECTIONAL_MIN) return []
  const out: EffortMetric[] = []
  if (c.separated && c.verdict === 'insufficient') out.push('tools')
  if (c.timeSeparated && c.timeVerdict === 'insufficient') out.push('agentS')
  if (c.tokensSeparated && c.tokensVerdict === 'insufficient') out.push('tokens')
  return out
}

export function contrastEffort(
  variant: EffortSample[],
  control: EffortSample[],
): EffortContrast | null {
  const v = effortOf(variant)
  const c = effortOf(control)
  if (!v || !c) return null
  const tools = effortVerdict(
    variant.map((s) => s.tools),
    control.map((s) => s.tools),
  )
  const time = effortVerdict(
    variant.map((s) => s.agentMs),
    control.map((s) => s.agentMs),
  )
  const vTok = tokenValues(variant)
  const cTok = tokenValues(control)
  // Both sides need at least one usage sample. Missing usage is not `insufficient`.
  const tokens = vTok.length && cTok.length ? effortVerdict(vTok, cTok) : null
  const reported = vTok.length + cTok.length
  const unreported = reported > 0 && reported < variant.length + control.length
  return {
    variant: v,
    control: c,
    toolsRatio: ratio(v.tools.median, c.tools.median),
    agentMsRatio: ratio(v.agentMs.median, c.agentMs.median),
    agentMsDelta: v.agentMs.median - c.agentMs.median,
    toolsP: tools.p,
    agentMsP: time.p,
    separated: apart(
      variant.map((s) => s.tools),
      control.map((s) => s.tools),
    ),
    timeSeparated: apart(
      variant.map((s) => s.agentMs),
      control.map((s) => s.agentMs),
    ),
    tokensSeparated: tokens ? apart(vTok, cTok) : null,
    verdict: tools.verdict,
    timeVerdict: time.verdict,
    tokensRatio: tokens && v.tokens && c.tokens ? ratio(v.tokens.median, c.tokens.median) : null,
    tokensP: tokens?.p ?? null,
    tokensVerdict: tokens?.verdict ?? null,
    ...(unreported ? { tokensNote: TOKENS_UNREPORTED } : {}),
  }
}

/** The counted attempts of one cell of an eval, as effort samples. */
export const cellSamples = (e: Pick<EvalEntry, 'attempts'>, cellKey: string): EffortSample[] =>
  e.attempts.filter((a) => a.cell === cellKey && counted(a)).map(effortSample)

export const cellEffort = (e: Pick<EvalEntry, 'attempts'>, cellKey: string) =>
  effortOf(cellSamples(e, cellKey))

/** A variant cell's effort against its control's, in the same run; null for controls. */
export function cellContrast(
  e: Pick<EvalEntry, 'attempts' | 'cells'>,
  cellKey: string,
): EffortContrast | null {
  const cell = e.cells.find((c) => c.key === cellKey)
  if (!cell?.lift) return null
  return contrastEffort(cellSamples(e, cellKey), cellSamples(e, cell.lift.vs))
}

// ── Labels ───────────────────────────────────────────────────────────────────────────────────

/** `4`, `4.5`: medians of counts are whole or halves. */
export const formatCount = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

export const formatRatio = (r: number | null) => (r === null ? '×–' : `×${r.toFixed(2)}`)

/** Below this, agent time rounds under a tenth of a second and prints `<0.1s`. */
const TENTH_MS = 50

/** Two agent times that both print `<0.1s` have no ratio worth printing. */
export const bothUnderATenth = (a: number, b: number) => a < TENTH_MS && b < TENTH_MS

/** Seconds for agent time: `<0.1s`, `0.4s`, `21s`, `1m 05s`. */
export function formatSeconds(ms: number): string {
  // Under 10s, a tenth: `0.2s vs 0.4s` reads with its ×0.50 where `0s vs 0s` doesn't.
  if (ms < 9950) return ms < TENTH_MS ? '<0.1s' : `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/**
 * `model 1m 05s · tools 12s · waiting 1m 21s · other 3m 22s`: model left out when unknown,
 * waiting when there was none.
 */
export const splitLabel = (s: TimeSplit) =>
  [
    ...(s.modelMs === null ? [] : [`model ${formatSeconds(s.modelMs)}`]),
    `tools ${formatSeconds(s.toolMs)}`,
    ...(s.waitingMs > 0 ? [`waiting ${formatSeconds(s.waitingMs)}`] : []),
    `other ${formatSeconds(s.otherMs)}`,
  ].join(' · ')

const formatP = (p: number | null) =>
  p === null ? '' : ` (p = ${p < 0.001 ? '<0.001' : p.toFixed(3)})`

export const VERDICT_TEXT: Record<EffortVerdict, (what: string) => string> = {
  fewer: (what) => `fewer ${what}`,
  more: (what) => `more ${what}`,
  noise: () => 'within noise',
  insufficient: () => 'too few attempts to test',
}

const toolsVerdictText = (c: EffortContrast): string =>
  c.verdict === 'fewer' || c.verdict === 'more'
    ? `${VERDICT_TEXT[c.verdict]('tool calls')}${formatP(c.toolsP)}`
    : VERDICT_TEXT[c.verdict]('')

/** Token verdict after the tools one; empty when omitted or already covered as insufficient. */
const tokensVerdictText = (c: EffortContrast): string => {
  if (c.tokensVerdict === null) return ''
  if (c.verdict === 'insufficient' && c.tokensVerdict === 'insufficient') return ''
  if (c.tokensVerdict === 'fewer' || c.tokensVerdict === 'more') {
    return `; ${VERDICT_TEXT[c.tokensVerdict]('tokens')}${formatP(c.tokensP)}`
  }
  if (c.tokensVerdict === 'noise') return '; tokens within noise'
  return `; ${VERDICT_TEXT[c.tokensVerdict]('')}`
}

/**
 * `tools 5 vs 43 (×0.11), agent 21s vs 46s (×0.47): too few attempts to test` for a variant
 * against its control; with enough attempts, `fewer tool calls (p = 0.029)`. Tokens fold in
 * when both sides have usage samples; they are omitted (not `insufficient`) when either does not.
 * A metric too small to test whose ranges don't overlap says so: `(×0.37, no overlap)`. Agent
 * times both under a tenth of a second have no ratio: `agent <0.1s vs <0.1s`.
 */
export function effortLabel(c: EffortContrast): string {
  const [va, ca] = [c.variant.agentMs.median, c.control.agentMs.median]
  const tiny = bothUnderATenth(va, ca)
  const apartOn = new Set(directional(c).filter((m) => !(tiny && m === 'agentS')))
  const r = (metric: EffortMetric, value: number | null) =>
    `(${formatRatio(value)}${apartOn.has(metric) ? ', no overlap' : ''})`
  const tools = `tools ${formatCount(c.variant.tools.median)} vs ${formatCount(c.control.tools.median)} ${r('tools', c.toolsRatio)}`
  const time = `agent ${formatSeconds(va)} vs ${formatSeconds(ca)}${tiny ? '' : ` ${r('agentS', c.agentMsRatio)}`}`
  const parts = [tools, time]
  if (c.tokensVerdict !== null && c.variant.tokens && c.control.tokens) {
    parts.push(
      `tokens ${formatTokens(c.variant.tokens.median)} vs ${formatTokens(c.control.tokens.median)} ${r('tokens', c.tokensRatio)}`,
    )
  }
  if (c.variant.usd && c.control.usd) {
    const [vu, cu] = [c.variant.usd.median, c.control.usd.median]
    parts.push(`cost ${formatUsd(vu)} vs ${formatUsd(cu)} (${formatRatio(ratio(vu, cu))})`)
  }
  const n = apartOn.size ? ` (n = ${c.variant.n} vs ${c.control.n})` : ''
  return `${parts.join(', ')}: ${toolsVerdictText(c)}${tokensVerdictText(c)}${n}`
}

/**
 * One cell's effort on its own: `tools 43 · agent 46s`, plus tokens and cost when any attempt
 * reported them.
 */
export const effortSummary = (e: Pick<CellEffort, 'tools' | 'agentMs' | 'tokens' | 'usd'>) =>
  [
    `tools ${formatCount(e.tools.median)}`,
    `agent ${formatSeconds(e.agentMs.median)}`,
    ...(e.tokens ? [`tokens ${formatTokens(e.tokens.median)}`] : []),
    ...(e.usd ? [`cost ${formatUsd(e.usd.median)}`] : []),
  ].join(' · ')

/**
 * The same cell between two runs: `tools 44 → 10 (×0.23) · agent 45s → 21s (×0.47)`, then
 * `waiting 0s → 1m 21s` when either side waited on a background job.
 */
export function effortChangeLabel(
  base: Pick<CellEffort, 'tools' | 'agentMs' | 'tokens' | 'split' | 'usd'>,
  head: Pick<CellEffort, 'tools' | 'agentMs' | 'tokens' | 'split' | 'usd'>,
): string {
  const waited = base.split && head.split && (base.split.waitingMs || head.split.waitingMs)
  const waiting = waited
    ? ` · waiting ${formatSeconds(base.split?.waitingMs ?? 0)} → ${formatSeconds(head.split?.waitingMs ?? 0)}`
    : ''
  return `${effortCore(base, head)}${waiting}`
}

function effortCore(
  base: Pick<CellEffort, 'tools' | 'agentMs' | 'tokens' | 'usd'>,
  head: Pick<CellEffort, 'tools' | 'agentMs' | 'tokens' | 'usd'>,
): string {
  const t = ratio(head.tools.median, base.tools.median)
  const a = ratio(head.agentMs.median, base.agentMs.median)
  const [ba, ha] = [base.agentMs.median, head.agentMs.median]
  const agent = `agent ${formatSeconds(ba)} → ${formatSeconds(ha)}${bothUnderATenth(ba, ha) ? '' : ` (${formatRatio(a)})`}`
  const core = `tools ${formatCount(base.tools.median)} → ${formatCount(head.tools.median)} (${formatRatio(t)}) · ${agent}`
  const parts = [core]
  if (base.tokens && head.tokens) {
    const tok = ratio(head.tokens.median, base.tokens.median)
    parts.push(
      `tokens ${formatTokens(base.tokens.median)} → ${formatTokens(head.tokens.median)} (${formatRatio(tok)})`,
    )
  }
  if (base.usd && head.usd) {
    const usd = ratio(head.usd.median, base.usd.median)
    parts.push(
      `cost ${formatUsd(base.usd.median)} → ${formatUsd(head.usd.median)} (${formatRatio(usd)})`,
    )
  }
  return parts.join(' · ')
}
