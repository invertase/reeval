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
 * The one request the SDK sends the API key on (checked with @cursor/sdk 1.0.32): it trades
 * the key for session tokens, which it sends everywhere else. The same endpoint the Cursor CLI
 * uses, so a gateway that brokers the CLI brokers the SDK unchanged.
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

const catalogs = new Map<string, Promise<CursorSdkModelEntry[]>>()

/** `GET /v1/models` with the real key, on the host, once per key and process. */
export function fetchCursorModelCatalog(
  credentials: CursorSdkCredentials,
  options: { baseUrl?: string; fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<CursorSdkModelEntry[]> {
  const baseUrl = (options.baseUrl ?? CURSOR_API_URL).replace(/\/+$/, '')
  const cacheKey = `${baseUrl} ${credentials.apiKey}`
  let pending = catalogs.get(cacheKey)
  if (!pending) {
    pending = (async () => {
      const res = await (options.fetch ?? fetch)(`${baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${credentials.apiKey}` },
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (!res.ok) {
        throw new Error(`Cursor's model catalog request failed: HTTP ${res.status}`)
      }
      const body = (await res.json()) as { items?: unknown } | unknown[]
      const items = Array.isArray(body) ? body : (body as { items?: unknown }).items
      if (!Array.isArray(items)) throw new Error("Cursor's model catalog has no items")
      return items as CursorSdkModelEntry[]
    })()
    pending.catch(() => catalogs.delete(cacheKey))
    catalogs.set(cacheKey, pending)
  }
  return pending
}

/** The catalog entries for `model` (by id or alias), or the whole catalog if none match. */
export function catalogFor(catalog: CursorSdkModelEntry[], model: string | undefined) {
  if (!model) return catalog
  const match = catalog.filter((m) => m.id === model || m.aliases?.includes(model))
  return match.length > 0 ? match : catalog
}
