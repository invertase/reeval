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
  /** Aborts the call, and any wait before a retry, with the signal's reason. */
  signal?: AbortSignal
  /** Each try's deadline; default the client's `timeoutMs`. */
  timeoutMs?: number
  /** `false` tries once. POSTs try once unless this is set. */
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
  /** Retries for the calls that may be repeated (GET, PUT, DELETE). */
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
  options?: CallOptions | undefined
}

const DEFAULT_TIMEOUT_MS = 30_000
const RETRIED_STATUSES = new Set([408, 425, 429])

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

/** The platform's HTTP transport: auth, timeouts, redirects refused, retries and errors. */
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
    base.search = ''
    base.hash = ''
    if (!base.pathname.endsWith('/')) base.pathname += '/'
    this.base = base
    this.#options = options
  }

  /** `segments` under the base URL, each one encoded; an empty one is refused before any call. */
  url(segments: readonly string[], query?: Record<string, string | undefined>): URL {
    const path = segments.map((s, i) => {
      if (typeof s !== 'string' || s === '') {
        throw new TypeError(`path segment ${i} of /${segments.join('/')} is empty`)
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
    const token = await this.#options.auth?.()
    return token ? { authorization: `Bearer ${token}` } : {}
  }

  /** Sends the request, retrying where it may; an answer that isn't ok or allowed throws. */
  async send(req: Send): Promise<Response> {
    const { options = {} } = req
    const idempotent = req.method !== 'POST'
    const policy =
      options.retry === false || (!idempotent && options.retry === undefined)
        ? { attempts: 1 }
        : { ...this.#options.retry, ...options.retry }
    const attempts = Math.max(1, policy.attempts ?? 3)
    const baseMs = policy.baseMs ?? 250
    const maxMs = policy.maxMs ?? 10_000
    const sleep = this.#options.sleep ?? defaultSleep
    const random = this.#options.random ?? Math.random
    for (let attempt = 1; ; attempt++) {
      const failure = await this.#try(req)
      if (failure instanceof Response) return failure
      const last = attempt >= attempts || !failure.retryable
      const wait =
        failure.retryAfterMs ?? Math.round(random() * Math.min(maxMs, baseMs * 2 ** (attempt - 1)))
      if (last || wait > maxMs) throw failure
      await sleep(wait, options.signal)
    }
  }

  /** One try: the answer, or the error it makes. */
  async #try(req: Send): Promise<Response | ApiError> {
    const { options = {} } = req
    const fail = (
      o: Omit<ConstructorParameters<typeof ApiError>[0], 'operation' | 'method' | 'path'>,
    ) =>
      new ApiError({ ...o, operation: req.operation, method: req.method, path: req.url.pathname })
    options.signal?.throwIfAborted()
    const headers: Record<string, string> = {
      accept: req.accept ?? 'application/json',
      ...this.#options.headers,
      ...req.headers,
      ...(req.auth !== false && (await this.authHeaders())),
    }
    let body: BodyInit | undefined
    if (req.body && 'json' in req.body) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(req.body.json)
    } else if (req.body) {
      headers['content-type'] = req.body.contentType
      body = req.body.bytes as BodyInit
    }
    const timeout = AbortSignal.timeout(
      options.timeoutMs ?? this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
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
      if (options.signal?.aborted) throw options.signal.reason
      const reason = error instanceof Error ? String(error.cause ?? error) : String(error)
      return fail({
        kind: 'unreachable',
        retryable: true,
        detail: `no answer (${reason})`,
        cause: error,
      })
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => {})
      return fail({
        kind: 'redirected',
        status: res.status,
        detail: `redirected (HTTP ${res.status})`,
      })
    }
    if (res.ok || req.allow?.includes(res.status)) return res
    const text = await res.text().catch(() => '')
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {}
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
  }

  /** The answer's JSON body checked against `schema`; a body that isn't it is `malformed`. */
  async json<S extends z.ZodType>(req: Send, res: Response, schema: S): Promise<z.output<S>> {
    const text = await res.text().catch(() => '')
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {}
    const result = schema.safeParse(parsed)
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
      body: parsed,
    })
  }
}
