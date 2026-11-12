import type { VmProviderId } from './types.ts'

/** What a failed call means, whatever the provider. */
export type VmErrorKind =
  /** The key was refused. */
  | 'auth'
  /** Too many calls or starts for now; `retryAt` says when, when the provider did. */
  | 'rate-limited'
  /** The account may not start more (a cap, a plan, a blocked account). */
  | 'quota'
  /** The provider has no machines to give right now. */
  | 'capacity'
  | 'not-found'
  /** The name or state conflicts with another call (a save in progress, a name taken). */
  | 'conflict'
  /** The request was malformed or asked for something the provider doesn't offer. */
  | 'invalid'
  /** No response arrived. */
  | 'network'
  | 'unknown'

/** Every adapter's calls fail with this, never with a provider's own error type. */
export class VmApiError extends Error {
  override readonly name = 'VmApiError'
  readonly provider: VmProviderId
  /** The call that failed: `create`, `get <id>`, … */
  readonly call: string
  /** HTTP status, or 0 when no response arrived. */
  readonly status: number
  /** The provider's error code (`rate_limited`, `not_found`, …), else `http_<status>` or `network`. */
  readonly code: string
  readonly kind: VmErrorKind
  /** The same call may succeed later. */
  readonly retryable: boolean
  /** When the provider said the call may succeed (epoch ms). */
  readonly retryAt?: number
  /** The status and the provider's own words: `429 rate_limited: …`. */
  readonly detail: string

  constructor(o: {
    provider: VmProviderId
    label: string
    status: number
    code: string
    kind: VmErrorKind
    retryable: boolean
    retryAt?: number
    detail: string
  }) {
    super(`${o.provider} ${o.label}: ${o.detail}`)
    this.provider = o.provider
    this.call = o.label
    this.status = o.status
    this.code = o.code
    this.kind = o.kind
    this.retryable = o.retryable
    this.detail = o.detail
    if (o.retryAt !== undefined) this.retryAt = o.retryAt
  }

  /**
   * The call, status and code without the provider's message, which can quote the request (and so
   * a machine's environment): for logs and anywhere the provider's words aren't wanted.
   */
  get summary(): string {
    return this.status
      ? `${this.provider} ${this.call}: ${this.status} ${this.code}`
      : `${this.provider} ${this.call}: no response`
  }
}

/** The furthest ahead a refusal's own answer is believed. */
const MAX_RETRY_AT_MS = 24 * 60 * 60 * 1000

const objectOf = (value: unknown) =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined

/** `Retry-After` as epoch ms: seconds, or an HTTP date. */
function retryAfterHeader(header: string | null, now: number): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return now + Math.ceil(seconds * 1000)
  const at = Date.parse(header)
  return Number.isNaN(at) ? undefined : Math.max(now, at)
}

/**
 * The time a message names (`… start again at 14:05 UTC`), today or else tomorrow (epoch ms). A
 * time in the last minute is now: the minute it names hasn't ended.
 */
function namedTime(message: unknown, now: number): number | undefined {
  if (typeof message !== 'string') return undefined
  const named = /\b(\d{1,2}):(\d{2})(?::(\d{2}))? ?UTC\b/.exec(message)
  if (!named) return undefined
  const day = new Date(now)
  const at = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    Number(named[1]),
    Number(named[2]),
    Number(named[3] ?? 0),
  )
  if (at >= now) return at
  return at > now - 60_000 ? now : at + 86_400_000
}

/**
 * When a refusal says to try again (epoch ms), at most a day ahead: its body's `nextStartAt` or
 * `retryAfterSeconds` (at the top, in `error` or in `details`), else `Retry-After`, else the time
 * its message names.
 */
export function retryAtOf(
  body: unknown,
  header: string | null,
  message: string,
  now = Date.now(),
): number | undefined {
  const at = saidRetryAt(body, header, message, now)
  return at === undefined ? undefined : Math.min(Math.max(at, now), now + MAX_RETRY_AT_MS)
}

function saidRetryAt(body: unknown, header: string | null, message: string, now: number) {
  const top = objectOf(body)
  const nested = objectOf(top?.error)
  const places = [top, nested, objectOf(top?.details), objectOf(nested?.details)]
  for (const place of places) {
    const at = place?.nextStartAt
    const parsed = typeof at === 'string' ? Date.parse(at) : Number.NaN
    if (!Number.isNaN(parsed)) return parsed
  }
  for (const place of places) {
    const seconds = place?.retryAfterSeconds
    if (typeof seconds === 'number' && Number.isFinite(seconds)) {
      return now + Math.max(0, seconds) * 1000
    }
  }
  return retryAfterHeader(header, now) ?? namedTime(message, now)
}
