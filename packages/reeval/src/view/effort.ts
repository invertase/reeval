// Effort next to lift: tool calls, agent time, and tokens per cell, and a variant's against
// its control. Pass rate can't tell a skill that makes the agent 4× cheaper from no skill at
// all when both pass, so effort is reported with its own test and verdict. No USD: prices
// aren't reeval's to know.
import type { AttemptRecord, EvalEntry } from '../history/types.ts'
import { totalTokens } from '../usage.ts'
import { mannWhitney, median, minimumP, quantile } from '../stats.ts'

/** Below this two-sided p, an effort difference is an effect. */
export const EFFORT_ALPHA = 0.05

/** Some counted attempts reported no usage. Not a verdict; never printed as one. */
export const TOKENS_UNREPORTED = 'some cells did not report usage'

export type EffortSample = {
  tools: number
  agentMs: number
  fileEdits: number
  /** Total tokens when this attempt reported usage; omitted when the harness dropped it. */
  tokens?: number
}
export type Spread = { median: number; q1: number; q3: number }
/** One cell's effort over its counted attempts (passes and fails; infra errors and skips aren't). */
export type CellEffort = {
  n: number
  tools: Spread
  agentMs: Spread
  fileEdits: number
  /** Over the counted attempts that reported usage; omitted when none did. */
  tokens?: Spread
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
  a: Pick<AttemptRecord, 'activity' | 'timings' | 'usage'>,
): EffortSample => ({
  tools: a.activity.tools,
  agentMs: a.timings.agentMs,
  fileEdits: a.activity.fileEdits,
  ...(a.usage ? { tokens: totalTokens(a.usage) } : {}),
})

const counted = (a: Pick<AttemptRecord, 'outcome'>) => a.outcome === 'pass' || a.outcome === 'fail'

const spread = (values: number[]): Spread => ({
  median: median(values) ?? 0,
  q1: quantile(values, 0.25) ?? 0,
  q3: quantile(values, 0.75) ?? 0,
})

/** Token totals from the attempts that reported usage; empty when none did. */
export const tokenValues = (samples: EffortSample[]): number[] =>
  samples.flatMap((s) => (s.tokens === undefined ? [] : [s.tokens]))

export function effortOf(samples: EffortSample[]): CellEffort | null {
  if (samples.length === 0) return null
  const tokens = tokenValues(samples)
  return {
    n: samples.length,
    tools: spread(samples.map((s) => s.tools)),
    agentMs: spread(samples.map((s) => s.agentMs)),
    fileEdits: median(samples.map((s) => s.fileEdits)) ?? 0,
    ...(tokens.length ? { tokens: spread(tokens) } : {}),
  }
}

/** The verdict of an exact rank test of `xs` (variant) against `ys` (control). */
export function effortVerdict(
  xs: number[],
  ys: number[],
): { p: number | null; verdict: EffortVerdict } {
  const p = mannWhitney(xs, ys)
  if (minimumP(xs.length, ys.length) >= EFFORT_ALPHA) return { p, verdict: 'insufficient' }
  if (p === null || p >= EFFORT_ALPHA) return { p, verdict: 'noise' }
  return { p, verdict: (median(xs) ?? 0) < (median(ys) ?? 0) ? 'fewer' : 'more' }
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b)

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
  const vt = variant.map((s) => s.tools)
  const ct = control.map((s) => s.tools)
  return {
    variant: v,
    control: c,
    toolsRatio: ratio(v.tools.median, c.tools.median),
    agentMsRatio: ratio(v.agentMs.median, c.agentMs.median),
    agentMsDelta: v.agentMs.median - c.agentMs.median,
    toolsP: tools.p,
    agentMsP: time.p,
    separated: Math.max(...vt) < Math.min(...ct) || Math.min(...vt) > Math.max(...ct),
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

/** Seconds for agent time: `21s`, `1m 05s`. */
export function formatSeconds(ms: number): string {
  // Under 10s, a tenth: `0.2s vs 0.4s` reads with its ×0.50 where `0s vs 0s` doesn't.
  if (ms < 9950) return ms < 50 ? '0s' : `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

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
 */
export function effortLabel(c: EffortContrast): string {
  const tools = `tools ${formatCount(c.variant.tools.median)} vs ${formatCount(c.control.tools.median)} (${formatRatio(c.toolsRatio)})`
  const time = `agent ${formatSeconds(c.variant.agentMs.median)} vs ${formatSeconds(c.control.agentMs.median)} (${formatRatio(c.agentMsRatio)})`
  const parts = [tools, time]
  if (c.tokensVerdict !== null && c.variant.tokens && c.control.tokens) {
    parts.push(
      `tokens ${formatCount(c.variant.tokens.median)} vs ${formatCount(c.control.tokens.median)} (${formatRatio(c.tokensRatio)})`,
    )
  }
  return `${parts.join(', ')}: ${toolsVerdictText(c)}${tokensVerdictText(c)}`
}

/** One cell's effort on its own: `tools 43 · agent 46s`, plus tokens when any attempt reported them. */
export const effortSummary = (e: Pick<CellEffort, 'tools' | 'agentMs' | 'tokens'>) =>
  e.tokens
    ? `tools ${formatCount(e.tools.median)} · agent ${formatSeconds(e.agentMs.median)} · tokens ${formatCount(e.tokens.median)}`
    : `tools ${formatCount(e.tools.median)} · agent ${formatSeconds(e.agentMs.median)}`

/** The same cell between two runs: `tools 44 → 10 (×0.23) · agent 45s → 21s (×0.47)`. */
export function effortChangeLabel(
  base: Pick<CellEffort, 'tools' | 'agentMs' | 'tokens'>,
  head: Pick<CellEffort, 'tools' | 'agentMs' | 'tokens'>,
): string {
  const t = ratio(head.tools.median, base.tools.median)
  const a = ratio(head.agentMs.median, base.agentMs.median)
  const core = `tools ${formatCount(base.tools.median)} → ${formatCount(head.tools.median)} (${formatRatio(t)}) · agent ${formatSeconds(base.agentMs.median)} → ${formatSeconds(head.agentMs.median)} (${formatRatio(a)})`
  if (!base.tokens || !head.tokens) return core
  const tok = ratio(head.tokens.median, base.tokens.median)
  return `${core} · tokens ${formatCount(base.tokens.median)} → ${formatCount(head.tokens.median)} (${formatRatio(tok)})`
}
