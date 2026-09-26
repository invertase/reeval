import { UsageError } from './errors.ts'
import type { Duration } from './types.ts'

const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const

/** A duration in milliseconds, more than zero: `90s`, `15m` or a number of milliseconds. */
export function parseDuration(value: Duration): number {
  let ms = value as number
  if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value)
    if (!match) throw new UsageError(`Invalid duration "${value}". Use e.g. "90s" or "15m".`)
    ms = Number(match[1]) * UNITS[match[2] as keyof typeof UNITS]
  }
  if (!(ms > 0 && Number.isFinite(ms))) {
    const shown = typeof value === 'string' ? `"${value}"` : String(value)
    throw new UsageError(
      `Invalid duration ${shown}. A duration is more than zero: use e.g. "90s" or "15m".`,
    )
  }
  return ms
}
