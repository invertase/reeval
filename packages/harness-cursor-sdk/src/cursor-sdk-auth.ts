import type {
  HarnessV1AuthenticationEnvironment,
  HarnessV1RequestTransformation,
} from '@ai-sdk/harness'
import { isHarnessAuthenticationEnvironment } from '@ai-sdk/harness/utils'

/** The only credential the adapter uses: a Cursor user or service-account API key. */
export const CURSOR_SDK_CREDENTIAL_ENV = 'CURSOR_API_KEY'
/** The agent backend. The SDK's local runtime talks to it only, once the model catalog is given. */
export const CURSOR_BACKEND_URL = 'https://api2.cursor.sh'
/** Cursor's public API: the model catalog and `GET /v1/agents/{id}/usage`. Called from the host. */
export const CURSOR_API_URL = 'https://api.cursor.com'
/**
 * The SDK looks the model up in this catalog instead of calling `GET api.cursor.com/v1/models`
 * with the API key. The adapter fetches it on the host, so the sandbox never needs that host.
 */
export const CURSOR_SDK_MODEL_CATALOG_ENV = 'CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON'

/** `'auto'` reads `CURSOR_API_KEY` from the host. An environment object uses only what it holds. */
export type CursorSdkAuthentication = 'auto' | HarnessV1AuthenticationEnvironment

export type CursorSdkCredentials = { apiKey: string }

export function resolveCursorSdkCredentials(
  auth: CursorSdkAuthentication = 'auto',
  hostEnv: Readonly<Record<string, string | undefined>> = process.env,
): CursorSdkCredentials {
  if (auth !== 'auto' && !isHarnessAuthenticationEnvironment(auth)) {
    throw new Error(
      `Cursor SDK auth must be 'auto' or an environment object such as { ${CURSOR_SDK_CREDENTIAL_ENV}: '…' } (got ${JSON.stringify(auth)})`,
    )
  }
  const env = auth === 'auto' ? hostEnv : auth
  const apiKey = env[CURSOR_SDK_CREDENTIAL_ENV]
  if (!apiKey) {
    throw new Error(
      `${CURSOR_SDK_CREDENTIAL_ENV} isn't set, so the Cursor SDK can't authenticate. It needs a Cursor user or service-account API key.`,
    )
  }
  return { apiKey }
}

/**
 * The one request the SDK sends the API key on: it
 * trades the key for session tokens, which it sends everywhere else. The same endpoint the Cursor
 * CLI uses, so a gateway that brokers the CLI brokers the SDK unchanged.
 */
export function cursorSdkEndpoints() {
  return [
    { host: 'api2.cursor.sh', path: { exact: '/auth/exchange_user_api_key' }, method: ['POST'] },
  ] as const satisfies ReadonlyArray<
    Pick<HarnessV1RequestTransformation['match'], 'host' | 'path' | 'method'>
  >
}

/** Swaps the sandbox's placeholder for the real key on the key exchange, and nowhere else. */
export function createCursorSdkRequestTransformations({
  credentials,
  placeholder,
  headers,
}: {
  credentials: CursorSdkCredentials
  placeholder: string
  /** Extra headers for the agent backend, e.g. from `HarnessV1StartOptions.headers`. */
  headers?: Readonly<Record<string, string>>
}): HarnessV1RequestTransformation[] {
  const [exchange] = cursorSdkEndpoints()
  return [
    {
      match: {
        host: exchange.host,
        path: exchange.path,
        method: [...exchange.method],
        headers: [{ key: { exact: 'Authorization' }, value: { exact: `Bearer ${placeholder}` } }],
      },
      transform: { headers: { Authorization: `Bearer ${credentials.apiKey}` } },
    },
    ...(headers && Object.keys(headers).length > 0
      ? [{ match: { host: exchange.host }, transform: { headers: { ...headers } } }]
      : []),
  ]
}

/** A `Cursor.models.list()` entry, loosely. */
export type CursorSdkModelEntry = { id: string; aliases?: string[]; [key: string]: unknown }

/**
 * The catalog couldn't be read. `transient` (a 5xx, a network error or a timeout) says another
 * try may succeed; a 4xx or a malformed body won't.
 */
export class CursorCatalogError extends Error {
  override name = 'CursorCatalogError'
  readonly transient: boolean
  constructor(message: string, transient: boolean) {
    super(message)
    this.transient = transient
  }
}

/** Each try's limit. */
const CURSOR_CATALOG_TIMEOUT_MS = 15_000
/** The waits before the second and third tries. */
const CURSOR_CATALOG_RETRY_DELAYS_MS = [1_000, 3_000] as const

const catalogs = new Map<string, Promise<CursorSdkModelEntry[]>>()

type CatalogFetchOptions = {
  baseUrl?: string
  fetch?: typeof fetch
  /** Stops this caller's wait only: the shared request goes on for the others. */
  signal?: AbortSignal
  timeoutMs?: number
  retryDelaysMs?: readonly number[]
}

async function readCatalog(
  url: string,
  apiKey: string,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<CursorSdkModelEntry[]> {
  let res: Response
  try {
    res = await doFetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const timedOut = (error as Error).name === 'TimeoutError'
    throw new CursorCatalogError(
      timedOut
        ? `Cursor's model catalog request failed: no response within ${timeoutMs / 1000}s`
        : `Cursor's model catalog request failed: ${(error as Error).message}`,
      true,
    )
  }
  if (!res.ok) {
    throw new CursorCatalogError(
      `Cursor's model catalog request failed: HTTP ${res.status}`,
      res.status >= 500,
    )
  }
  const body = (await res.json()) as { items?: unknown } | unknown[]
  const items = Array.isArray(body) ? body : (body as { items?: unknown }).items
  if (!Array.isArray(items))
    throw new CursorCatalogError("Cursor's model catalog has no items", false)
  return items as CursorSdkModelEntry[]
}

/** `promise`, or `signal`'s reason as soon as it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * `GET /v1/models` with the real key, on the host, once per key and process. Concurrent callers
 * share the request, which no caller's signal can abort; a transient failure is tried again
 * after each of `retryDelaysMs`, and the error that ends it says how many tries it took.
 */
export function fetchCursorModelCatalog(
  credentials: CursorSdkCredentials,
  options: CatalogFetchOptions = {},
): Promise<CursorSdkModelEntry[]> {
  const baseUrl = (options.baseUrl ?? CURSOR_API_URL).replace(/\/+$/, '')
  const cacheKey = `${baseUrl} ${credentials.apiKey}`
  let pending = catalogs.get(cacheKey)
  if (!pending) {
    const doFetch = options.fetch ?? fetch
    const timeoutMs = options.timeoutMs ?? CURSOR_CATALOG_TIMEOUT_MS
    const delays = options.retryDelaysMs ?? CURSOR_CATALOG_RETRY_DELAYS_MS
    pending = (async () => {
      for (let tries = 1; ; tries++) {
        try {
          return await readCatalog(`${baseUrl}/v1/models`, credentials.apiKey, doFetch, timeoutMs)
        } catch (error) {
          const delay = delays[tries - 1]
          if (!(error instanceof CursorCatalogError) || !error.transient) throw error
          if (delay === undefined) {
            throw tries === 1
              ? error
              : new CursorCatalogError(`${error.message} (tried ${tries} times)`, true)
          }
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    })()
    pending.catch(() => catalogs.delete(cacheKey))
    catalogs.set(cacheKey, pending)
  }
  return untilAborted(pending, options.signal)
}

/** The catalog entries for `model` (by id or alias), or the whole catalog if none match. */
export function catalogFor(catalog: CursorSdkModelEntry[], model: string | undefined) {
  if (!model) return catalog
  const match = catalog.filter((m) => m.id === model || m.aliases?.includes(model))
  return match.length > 0 ? match : catalog
}
