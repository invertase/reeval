/** What a failed call means. */
export type ApiErrorKind =
  /** The platform answered 4xx: the request, the sign-in or what it asked for was refused. */
  | 'refused'
  /** The platform answered 5xx. */
  | 'failed'
  /** No answer arrived: the connection failed or the attempt timed out. */
  | 'unreachable'
  /** The platform answered with a redirect, which the client never follows with the token. */
  | 'redirected'
  /** The platform answered 2xx with a body that isn't the route's shape. */
  | 'malformed'

/** Every call fails with this, never with `fetch`'s own errors. */
export class ApiError extends Error {
  override readonly name = 'ApiError'
  readonly kind: ApiErrorKind
  /** The call, as the client names it: `secrets.list`, `runs.create`, … */
  readonly operation: string
  readonly method: string
  /** The request's path, without its query. */
  readonly path: string
  /** HTTP status, or null when no answer arrived. */
  readonly status: number | null
  /** The platform's error code (`not_found`, `not_ready`, …), or an OAuth `error`. */
  readonly code: string | null
  /** The platform's own words for the failure, on one line, with control characters taken out. */
  readonly said: string | null
  /** The same call may succeed later. */
  readonly retryable: boolean
  /** How long the platform asked to wait before calling again, from `Retry-After`. */
  readonly retryAfterMs: number | null
  /** A refused or failed answer's parsed JSON body, when it had one; never a `malformed` one's. */
  readonly body: unknown

  constructor(o: {
    kind: ApiErrorKind
    operation: string
    method: string
    path: string
    status?: number | null
    code?: string | null
    said?: string | null
    retryable?: boolean
    retryAfterMs?: number | null
    body?: unknown
    detail?: string
    cause?: unknown
  }) {
    const status = o.status ?? null
    const why = o.said ?? o.detail ?? (status === null ? 'no answer' : `HTTP ${status}`)
    super(`${o.method} ${o.path}: ${why}`, o.cause === undefined ? undefined : { cause: o.cause })
    this.kind = o.kind
    this.operation = o.operation
    this.method = o.method
    this.path = o.path
    this.status = status
    this.code = o.code ?? null
    this.said = o.said ?? null
    this.retryable = o.retryable ?? false
    this.retryAfterMs = o.retryAfterMs ?? null
    this.body = o.body ?? null
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** Text from the platform as it may reach a terminal: no escape sequences from its side. */
export const printable = (text: string) => text.replace(CONTROL, '')

/**
 * The platform's code and words in a failed answer's body: its `{ error: { code, message } }`,
 * or OAuth's `{ error, error_description }` on the sign-in routes, or a bare `message`.
 */
export function describeFailure(body: unknown): {
  code: string | null
  said: string | null
  retryable: boolean
} {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const nested =
    typeof b.error === 'object' && b.error !== null ? (b.error as Record<string, unknown>) : null
  const text = (v: unknown) =>
    (typeof v === 'string' &&
      printable(v.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\t/g, ' ')).trim()) ||
    null
  const code = text(nested?.code) ?? text(b.error)
  const said =
    text(nested?.message) ?? text(b.error_description) ?? text(b.message) ?? text(b.error)
  return { code, said, retryable: nested?.retryable === true }
}

/** `Retry-After` as milliseconds from `now`: delay seconds or an HTTP date. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null
  const value = header.trim()
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}
