// Vercel AI Gateway as a route for a harness's model calls: the key it takes and the model ids it
// names. One key serves every harness here. `AI_GATEWAY_BASE_URL` moves every call to a gateway
// with Vercel's API at another URL.
import { apiHost, type RouteApi } from './api.ts'
import { everyModel, notGemini } from './effort.ts'
import type { Route, RouteConfig } from './route.ts'

const VERCEL_ORIGIN = 'https://ai-gateway.vercel.sh'

/** Vercel's own API, where `vercel()` goes unless `AI_GATEWAY_BASE_URL` names another. */
export const VERCEL_API: RouteApi = apiAt(VERCEL_ORIGIN)

export const VERCEL_HOST = apiHost(VERCEL_API)

/**
 * The host variable naming another gateway with Vercel's API, such as a proxy in front of it:
 * the origin, with any path its API is under, that stands for `https://ai-gateway.vercel.sh`.
 * The variable the AI SDK's harness adapters read for it, too.
 */
export const VERCEL_BASE_URL = 'AI_GATEWAY_BASE_URL'

/** What the adapters take Vercel's key as, whichever host variable it came from. */
export const VERCEL_KEY = 'AI_GATEWAY_API_KEY'
/** A Vercel project's short-lived token (`vercel env pull`), used when there's no key. */
export const VERCEL_OIDC = 'VERCEL_OIDC_TOKEN'

function apiAt(base: string): RouteApi {
  const origin = base.replace(/\/+$/, '')
  return { origin, openai: `${origin}/v1`, anthropic: origin }
}

/** `value` as the URL reeval calls: the parsed origin and path, with no trailing slash. */
const parsedBase = (value: string) => {
  const url = URL.parse(value)
  return url && `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

/** Where `vercel()`'s calls go: `AI_GATEWAY_BASE_URL`'s gateway, else Vercel's own API. */
export const vercelApi = (env: NodeJS.ProcessEnv = process.env): RouteApi => {
  const value = env[VERCEL_BASE_URL]
  return value ? apiAt(parsedBase(value) ?? value) : VERCEL_API
}

/** `AI_GATEWAY_BASE_URL` as the URL reeval calls, or undefined when it's unset. */
export const vercelBaseUrl = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  env[VERCEL_BASE_URL] ? vercelApi(env).origin : undefined

/**
 * Why `AI_GATEWAY_BASE_URL` can't be a gateway's URL, or undefined when it's unset or can: the
 * egress gateway swaps the key in over HTTPS only, a query, a fragment or a user would be lost on
 * the paths the agents add to it, and a value the URL parser rewrites (spaces, line breaks,
 * `https:host`) isn't the URL every agent would read from it.
 */
export function vercelBaseUrlProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[VERCEL_BASE_URL]
  if (!value) return undefined
  const url = URL.parse(value)
  const fix = `Set ${VERCEL_BASE_URL} to an https:// URL such as https://gateway.example.com, or unset it to call Vercel AI Gateway.`
  if (!url) return `${VERCEL_BASE_URL} (${JSON.stringify(value)}) isn't a URL. ${fix}`
  if (url.protocol !== 'https:') {
    return `${VERCEL_BASE_URL} (${JSON.stringify(value)}) isn't https://, and reeval sends the key only over HTTPS. ${fix}`
  }
  if (url.search || url.hash || url.username || url.password) {
    return `${VERCEL_BASE_URL} (${JSON.stringify(value)}) has a query, a fragment or a user, which the paths the agents add to it would lose. ${fix}`
  }
  const base = parsedBase(value)
  if (value.replace(/\/+$/, '') !== base) {
    return `${VERCEL_BASE_URL} (${JSON.stringify(value)}) reads as ${base}, and reeval sends the key only to a URL written as it reads. ${fix}`
  }
  return undefined
}

/** The host variable the key comes from: `AI_GATEWAY_API_KEY`, else `VERCEL_OIDC_TOKEN`. */
export const vercelCredential = (env: NodeJS.ProcessEnv = process.env) =>
  !env[VERCEL_KEY] && env[VERCEL_OIDC] ? VERCEL_OIDC : VERCEL_KEY

/** When a JWT's `exp` says it expires, or undefined when it isn't one or doesn't say. */
export function jwtExpiry(token: string): Date | undefined {
  const [, payload] = token.split('.')
  if (!payload) return undefined
  try {
    const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const json = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
    const { exp } = JSON.parse(json) as { exp?: unknown }
    return typeof exp === 'number' ? new Date(exp * 1000) : undefined
  } catch {
    return undefined
  }
}

/**
 * Why the run can't use Vercel's key, or undefined when it can: `VERCEL_OIDC_TOKEN` lasts about
 * 12 hours, and a run that starts on an expired one fails every attempt.
 */
export function vercelCredentialProblem(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): string | undefined {
  if (vercelCredential(env) !== VERCEL_OIDC) return undefined
  const expiry = jwtExpiry(env[VERCEL_OIDC] ?? '')
  if (!expiry || expiry > now) return undefined
  return `${VERCEL_OIDC} expired at ${expiry.toISOString()}, so vercel() can't authenticate. Run vercel env pull for a new one, or set ${VERCEL_KEY}.`
}

/** A harness on Vercel's key, with the model id Vercel serves for its own, if not as written. */
const keyed =
  (modelId?: (model: string) => string) =>
  (env: NodeJS.ProcessEnv): RouteConfig => ({
    credential: vercelCredential(env),
    ...(modelId ? { modelId } : {}),
  })

/** A gateway id as written, else the id under `provider`. */
const under = (provider: string) => (model: string) =>
  model.includes('/') ? model : `${provider}/${model}`

/** Why a harness can't follow `AI_GATEWAY_BASE_URL`, as `why` says: its calls stay on Vercel's host. */
const fixedUrl = (why: string) => (env: NodeJS.ProcessEnv) =>
  env[VERCEL_BASE_URL]
    ? `${why}, so reeval can't send its calls to ${VERCEL_BASE_URL} (${vercelApi(env).origin})`
    : undefined

/** Vercel AI Gateway: the harnesses reeval runs there, and why it doesn't run the rest. */
export const VERCEL_ROUTE: Route = {
  name: 'Vercel AI Gateway',
  api: vercelApi,
  routes: {
    'claude-code': keyed(),
    codex: keyed(under('openai')),
    goose: keyed((model) => model),
    opencode: keyed((model) => `vercel/${model}`),
    fx: keyed(under('openai')),
    'grok-build': keyed(under('xai')),
    pi: keyed((model) => model),
  },
  refusals: {
    cursor: "Cursor's agent only calls Cursor's own API",
    antigravity: "Antigravity's CLI only calls Google's API, with a Gemini key",
  },
  refusedAt: {
    goose: fixedUrl(`Goose's vercel_ai_gateway provider has ${VERCEL_HOST} built in`),
    opencode: fixedUrl(
      `reeval runs OpenCode's vercel provider only on the hosts its provider table probed, ${VERCEL_HOST}`,
    ),
  },
  // Claude Code's effort goes as on Anthropic's API, Codex's response names the effort it ran at,
  // pi and OpenCode send a Gemini model's thinking level under providerOptions, and Grok Build
  // sends reasoning_effort (an xAI model's own). Goose's vercel_ai_gateway provider sends none.
  unprovenEffort: { goose: everyModel, opencode: notGemini, pi: notGemini },
}
