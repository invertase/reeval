import { median, quantile, wilson } from '../../stats.ts'
import { formatDuration } from '../../text.ts'
import { formatTokens } from '../../usage.ts'
import { formatUsd } from '../cost.ts'
import type { Count, Delta, Figure, Interval, Rate, Spread } from './types.ts'

/** Tokens as people read them; `M` with one decimal from 10M. */
export function tokensText(n: number): string {
  if (n >= 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return formatTokens(n)
}

export function figure(value: number | null, text: string): Figure {
  return { value, text }
}

export function tokensFigure(value: number | null | undefined): Figure {
  if (value === null || value === undefined) return figure(null, 'not reported')
  return figure(value, tokensText(value))
}

export function durationFigure(ms: number | null | undefined): Figure {
  if (ms === null || ms === undefined) return figure(null, 'not reported')
  return figure(ms, formatDuration(ms))
}

export function usdFigure(usd: number | null | undefined): Figure {
  if (usd === null || usd === undefined) return figure(null, 'not reported')
  return figure(usd, formatUsd(usd))
}

export function countFigure(value: number | null | undefined, missing = 'not reported'): Figure {
  if (value === null || value === undefined) return figure(null, missing)
  return figure(value, String(value))
}

/** `<k> of <n>`. */
export function countOf(k: number, n: number): Count {
  return { k, n, text: `${k} of ${n}` }
}

/**
 * Pass-rate points: signed integer `pts`. Zero is `±0 pts`.
 * Ratio scales use `pctDelta` instead.
 */
export function ptsDelta(points: number | null): Delta {
  if (points === null || !Number.isFinite(points)) {
    return { value: null, unit: 'pts', text: 'n/a' }
  }
  const pct = Math.round(points * 100)
  if (pct === 0) return { value: 0, unit: 'pts', text: '±0 pts' }
  return { value: points, unit: 'pts', text: `${pct > 0 ? '+' : ''}${pct} pts` }
}

/**
 * Signed integer `%` of a positive ratio scale. Absolute value below 2 is `±0%`.
 * Baseline 0 is `n/a`.
 */
export function pctDelta(variant: number | null, baseline: number | null): Delta {
  if (
    variant === null ||
    baseline === null ||
    !Number.isFinite(variant) ||
    !Number.isFinite(baseline) ||
    baseline === 0
  ) {
    return { value: null, unit: 'pct', text: 'n/a' }
  }
  const raw = ((variant - baseline) / baseline) * 100
  const rounded = Math.round(raw)
  if (Math.abs(rounded) < 2) return { value: 0, unit: 'pct', text: '±0%' }
  return { value: raw / 100, unit: 'pct', text: `${rounded > 0 ? '+' : ''}${rounded}%` }
}

/** `95% CI <lo> pts to <hi> pts` as the interval's `text` when `unit` is points. */
export function ptsInterval(lo: number, hi: number): Interval {
  const fmt = (x: number) => {
    const n = Math.round(x * 100)
    return `${n > 0 ? '+' : ''}${n} pts`
  }
  return { lo, hi, text: `${fmt(lo)} to ${fmt(hi)}` }
}

/** Wilson rate: integer percent text, interval null at n = 0. */
export function rateOf(k: number, n: number): Rate {
  if (n <= 0) {
    return { k, n, rate: null, text: 'n/a', interval: null }
  }
  const rate = k / n
  const { low, high } = wilson(k, n)
  return {
    k,
    n,
    rate,
    text: `${Math.round(rate * 100)}%`,
    interval: ptsInterval(low, high),
  }
}

export function spreadOf(values: readonly number[], format: (n: number) => string): Spread | null {
  if (values.length === 0) return null
  const med = median(values)
  const q1 = quantile(values, 0.25)
  const q3 = quantile(values, 0.75)
  if (med === null || q1 === null || q3 === null) return null
  return {
    n: values.length,
    median: figure(med, format(med)),
    q1: figure(q1, format(q1)),
    q3: figure(q3, format(q3)),
  }
}

/** Median text plus optional `%` delta in parentheses (`461k (-42%)`). */
export function medianWithDelta(medianText: string, delta: Delta | null): string {
  if (!delta || delta.text === 'n/a') return medianText
  return `${medianText} (${delta.text})`
}

/** Judge score on its own scale: two decimals, never `%`. */
export function judgeScoreText(score: number): string {
  return score.toFixed(2)
}

/** Diff line counts excluding lockfiles: `+485 / -153`. */
export function diffLinesText(added: number, removed: number): string {
  return `+${added} / -${removed}`
}
