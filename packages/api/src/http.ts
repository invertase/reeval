import type { z } from 'zod'
import { ApiError, describeFailure, retryAfterMs } from './errors.ts'

/** A bearer token, or none: a missing one sends no `Authorization` header. */
export type Token = string | null | undefined

/** How a call that may be repeated retries an answer that may succeed later. */
export type RetryPolicy = {
  /** Tries in all, the first included; default 3. */
  attempts?: number
  /** The first wait, doubled for each try after it, with full jitter; default 250 ms. */
  baseMs?: number
  /** The longest wait. A `Retry-After` past it fails the call instead of waiting; default 10 s. */
  maxMs?: number
}

/** What every call takes. */
export type CallOptions = {
  /** Aborts the call, any wait before a retry, and the reading of its answer, with the signal's reason. */
  signal?: AbortSignal
  /**
   * Each try's deadline, reading the answer included; default the client's `timeoutMs`, and for
   * an upload a second more for every {@link UPLOAD_BYTES_PER_SECOND} of its body. A call that
   * hands back a stream (`runs.files`) stops the deadline once the headers arrive, so its body's
   * deadline is the caller's `signal`.
   */
  timeoutMs?: number
  /** `false` tries once. POSTs and uploads try once unless this is set. */
  retry?: false | RetryPolicy
}

export type ClientOptions = {
  /** The platform's URL, such as `https://cloud.reeval.ai`; its path, if any, prefixes every route. */
  baseUrl: URL | string
  /** The bearer token, read again for every request. */
  auth?: () => Token | Promise<Token>
  /** Headers every request carries, such as `user-agent`. */
  headers?: Record<string, string>
  /** Each try's deadline; default 30 s. */
  timeoutMs?: number
  /** Retries for the calls that may be repeated: GETs, and PUT and DELETE calls without an upload. */
  retry?: RetryPolicy
  fetch?: typeof fetch
  /** Waits `ms`, or rejects once `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Jitter's source, 0 to 1. */
  random?: () => number
}

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

export type Body = { json: unknown } | { bytes: Uint8Array | Blob | string; contentType: string }

export type Send = {
  operation: string
  method: Method
  url: URL
  body?: Body
  accept?: string
  headers?: Record<string, string>
  /** Whether the request carries the token; false for the sign-in routes and other origins. */
  auth?: boolean
  /** Statuses that come back as answers instead of errors, such as 404 for a lookup. */
  allow?: readonly number[]
  /** The answer's body is the caller's to read, outside the try's deadline. */
  stream?: boolean
  options?: CallOptions | undefined
}

const DEFAULT_TIMEOUT_MS = 30_000
/** The slowest upload a default deadline allows for. */
export const UPLOAD_BYTES_PER_SECOND = 32 * 1024
const RETRIED_STATUSES = new Set([408, 425, 429])
/** Statuses a `Response` can't be made with a body for. */
const NULL_BODY = new Set([204, 205, 304])
/** What `Headers` refuses in a value, or trims silently: control characters and edge whitespace. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const BAD_HEADER_VALUE = /[\u0000-\u0008\u000a-\u001f\u007f]|^[\t ]|[\t ]$/
/** A token is printable ASCII without spaces, as a bearer token's characters are. */
const BAD_TOKEN = /[^\u0021-\u007e]/

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', aborted, { once: true })
  })

const sizeOf = (body: Body | undefined): number | null => {
  if (!body || 'json' in body) return null
  const { bytes } = body
  if (typeof bytes === 'string') return new TextEncoder().encode(bytes).length
  return bytes instanceof Blob ? bytes.size : bytes.byteLength
}

/** The token as a header, or a refusal that names no part of it. */
function bearer(token: Token): Record<string, string> {
  if (!token) return {}
  if (typeof token !== 'string' || BAD_TOKEN.test(token)) {
    throw new TypeError(
      'the token has whitespace or a character a header cannot carry: give the token alone',
    )
  }
  return { authorization: `Bearer ${token}` }
}

function checkHeaders(headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || BAD_HEADER_VALUE.test(value)) {
      throw new TypeError(`the ${name} header's value has a character a header cannot carry`)
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/** What one try came to. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: ApiError }

/** The platform's HTTP transport: auth, deadlines, redirects refused, retries and errors. */
export class Transport {
  readonly base: URL
  readonly #options: ClientOptions

  constructor(options: ClientOptions) {
    const base = new URL(options.baseUrl)
    if (!/^https?:$/.test(base.protocol)) {
      throw new TypeError(`baseUrl is an http or https URL (got ${base.protocol})`)
    }
    if (base.username || base.password) {
      throw new TypeError("baseUrl can't carry a user name or password")
    }
    if (options.headers) checkHeaders(options.headers)
    base.search = ''
    base.hash = ''
    if (!base.pathname.endsWith('/')) base.pathname += '/'
    this.base = base
    this.#options = options
  }

  /**
   * `segments` under the base URL, each one encoded. An empty, `.` or `..` one is refused: it
   * would name another route.
   */
  url(segments: readonly string[], query?: Record<string, string | undefined>): URL {
    const path = segments.map((s, i) => {
      if (typeof s !== 'string' || s === '' || s === '.' || s === '..') {
        throw new TypeError(
          `path segment ${i} of /${segments.join('/')} is ${s === '' ? 'empty' : `"${s}"`}`,
        )
      }
      return encodeURIComponent(s)
    })
    const url = new URL(path.join('/'), this.base)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    return url
  }

  /** The `Authorization` header for a request the client doesn't make, such as a WebSocket. */
  async authHeaders(): Promise<Record<string, string>> {
    return bearer(await this.#options.auth?.())
  }

  /**
   * Sends the request and reads its answer with `read`, retrying both where the call may be
   * repeated; an answer that isn't ok or allowed throws. A bad token or header value throws a
   * `TypeError` before anything is sent.
   */
  async send<T = Response>(req: Send, read?: (res: Response) => Promise<T>): Promise<T> {
    const { options = {} } = req
    const size = sizeOf(req.body)
    const once = req.method === 'POST' || size !== null
    const policy =
      options.retry === false || (once && options.retry === undefined)
        ? { attempts: 1 }
        : { ...this.#options.retry, ...options.retry }
    const attempts = Math.max(1, policy.attempts ?? 3)
    const baseMs = policy.baseMs ?? 250
    const maxMs = policy.maxMs ?? 10_000
    const sleep = this.#options.sleep ?? defaultSleep
    const random = this.#options.random ?? Math.random
    const headers = await this.#headers(req)
    const timeoutMs =
      options.timeoutMs ??
      (this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS) +
        (size === null ? 0 : Math.ceil(size / UPLOAD_BYTES_PER_SECOND) * 1000)
    for (let attempt = 1; ; attempt++) {
      const outcome = await this.#try(req, headers, timeoutMs, read)
      if (outcome.ok) return outcome.value
      const failure = outcome.error
      const last = attempt >= attempts || !failure.retryable
      const wait =
        failure.retryAfterMs ?? Math.round(random() * Math.min(maxMs, baseMs * 2 ** (attempt - 1)))
      if (last || wait > maxMs) throw failure
      await sleep(wait, options.signal)
    }
  }

  /** Sends the request and reads its JSON answer against `schema`, retrying both as `send` does. */
  request<S extends z.ZodType>(req: Send, schema: S): Promise<z.output<S>> {
    return this.send(req, (res) => this.json(req, res, schema))
  }

  /** The answer's JSON body checked against `schema`; a body that isn't it is `malformed`. */
  async json<S extends z.ZodType>(req: Send, res: Response, schema: S): Promise<z.output<S>> {
    const result = schema.safeParse(parseJson(await res.text()))
    if (result.success) return result.data
    throw new ApiError({
      kind: 'malformed',
      operation: req.operation,
      method: req.method,
      path: req.url.pathname,
      status: res.status,
      detail: `the answer isn't the route's shape (${result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ')})`,
    })
  }

  async #headers(req: Send): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      accept: req.accept ?? 'application/json',
      ...this.#options.headers,
      ...req.headers,
      ...(req.body && {
        'content-type': 'json' in req.body ? 'application/json' : req.body.contentType,
      }),
    }
    checkHeaders(headers)
    return { ...headers, ...(req.auth !== false && (await this.authHeaders())) }
  }

  /** One try: the answer read, or the error it makes. */
  async #try<T>(
    req: Send,
    headers: Record<string, string>,
    timeoutMs: number,
    read: ((res: Response) => Promise<T>) | undefined,
  ): Promise<Outcome<T>> {
    const { options = {} } = req
    const fail = (
      o: Omit<ConstructorParameters<typeof ApiError>[0], 'operation' | 'method' | 'path'>,
    ): Outcome<T> => ({
      ok: false,
      error: new ApiError({
        ...o,
        operation: req.operation,
        method: req.method,
        path: req.url.pathname,
      }),
    })
    options.signal?.throwIfAborted()
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal
    /** No answer, or a cut-off one: the caller's abort, else a try to repeat. */
    const lost = (error: unknown, what: string): Outcome<T> => {
      if (options.signal?.aborted) throw options.signal.reason
      const cause = error instanceof Error ? error.cause : undefined
      const why = deadline.signal.aborted
        ? `past the ${timeoutMs} ms deadline`
        : cause instanceof Error
          ? cause.message
          : 'the connection failed'
      return fail({ kind: 'unreachable', retryable: true, detail: `${what} (${why})` })
    }
    try {
      let body: BodyInit | undefined
      if (req.body) {
        body = 'json' in req.body ? JSON.stringify(req.body.json) : (req.body.bytes as BodyInit)
      }
      let res: Response
      try {
        res = await (this.#options.fetch ?? fetch)(req.url, {
          method: req.method,
          headers,
          ...(body !== undefined && { body }),
          redirect: 'manual',
          signal,
        })
      } catch (error) {
        return lost(error, 'no answer')
      }
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        await res.body?.cancel().catch(() => {})
        return fail({
          kind: 'redirected',
          status: res.status,
          detail: `redirected (HTTP ${res.status})`,
        })
      }
      if (res.ok || req.allow?.includes(res.status)) {
        if (req.stream) {
          clearTimeout(timer)
          return { ok: true, value: (read ? await read(res) : res) as T }
        }
        let text: string
        try {
          text = await res.text()
        } catch (error) {
          return lost(error, 'the answer was cut off')
        }
        const copy = new Response(NULL_BODY.has(res.status) ? null : text, {
          status: res.status,
          headers: res.headers,
        })
        return { ok: true, value: (read ? await read(copy) : copy) as T }
      }
      let text = ''
      try {
        text = await res.text()
      } catch (error) {
        if (options.signal?.aborted || deadline.signal.aborted) {
          return lost(error, 'the answer was cut off')
        }
      }
      const parsed = parseJson(text)
      const { code, said, retryable } = describeFailure(parsed)
      return fail({
        kind: res.status >= 500 ? 'failed' : 'refused',
        status: res.status,
        code,
        said,
        retryable: retryable || res.status >= 500 || RETRIED_STATUSES.has(res.status),
        retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
        body: parsed,
      })
    } finally {
      clearTimeout(timer)
    }
  }
}
