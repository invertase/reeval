import { UsageError } from './errors.ts'
import type { Duration } from './types.ts'

const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const

/**
 * The longest timer Node sets: a longer `setTimeout` fires after 1 ms instead, so every duration
 * that reaches a timer is at most this (about 596h).
 */
export const MAX_TIMER_MS = 2 ** 31 - 1

/** The limit `MAX_TIMER_MS` sets, as a refusal says it. */
export const TIMER_LIMIT = `at most 596h (${MAX_TIMER_MS}ms), the longest timer Node can set`

/**
 * A duration in milliseconds, more than zero and at most `MAX_TIMER_MS`: `90s`, `15m` or a
 * number of milliseconds.
 */
export function parseDuration(value: Duration): number {
  let ms = value as number
  if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value)
    if (!match) throw new UsageError(`Invalid duration "${value}". Use e.g. "90s" or "15m".`)
    ms = Number(match[1]) * UNITS[match[2] as keyof typeof UNITS]
  }
  const shown = typeof value === 'string' ? `"${value}"` : String(value)
  if (!(ms > 0 && Number.isFinite(ms))) {
    throw new UsageError(
      `Invalid duration ${shown}. A duration is more than zero: use e.g. "90s" or "15m".`,
    )
  }
  if (ms > MAX_TIMER_MS)
    throw new UsageError(`Invalid duration ${shown}. A duration is ${TIMER_LIMIT}.`)
  return ms
}
