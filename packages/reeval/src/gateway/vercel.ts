// Vercel AI Gateway as a route for a harness's model calls: the key it takes, the requests the
// egress gateway brokers it on, and the model ids it names. One key serves every harness here.
// `AI_GATEWAY_BASE_URL` moves every call to a gateway with Vercel's API at another URL.
import {
  providerEndpoints,
  providerHosts,
  providerModelResponses,
  providerServedModel,
  resolveOpenCodeProvider,
} from '@reeval/harness-opencode/providers'
import type { EndpointMatch } from '@reeval/sandbox-docker'
import type { ModelSpecific } from '../harness/agents.ts'
import { anthropicPath, apiHost, type GatewayApi, openaiPath } from './api.ts'
import { everyModel, notGemini } from './effort.ts'
import type { GatewayRoute, RoutingGateway } from './routes.ts'

const VERCEL_ORIGIN = 'https://ai-gateway.vercel.sh'

/** Vercel's own API, where `vercel()` goes unless `AI_GATEWAY_BASE_URL` names another. */
export const VERCEL_API: GatewayApi = apiAt(VERCEL_ORIGIN)

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

function apiAt(base: string): GatewayApi {
  const origin = base.replace(/\/+$/, '')
  return { origin, openai: `${origin}/v1`, anthropic: origin }
}

/** `value` as the URL reeval calls: the parsed origin and path, with no trailing slash. */
const parsedBase = (value: string) => {
  const url = URL.parse(value)
  return url && `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

/** Where `vercel()`'s calls go: `AI_GATEWAY_BASE_URL`'s gateway, else Vercel's own API. */
export const vercelApi = (env: NodeJS.ProcessEnv = process.env): GatewayApi => {
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
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown
    }
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

const on = (api: GatewayApi, path: string, method: 'GET' | 'POST') =>
  ({ host: apiHost(api), path: { exact: path }, method: [method] }) as const satisfies EndpointMatch

/**
 * The response names the model that served it on the gateway's host, in Vercel's form
 * (`openai/gpt-5.6-luna`), with the reasoning effort when it says one.
 */
export const servedOn =
  (api: GatewayApi = VERCEL_API): NonNullable<ModelSpecific['servedModel']> =>
  ({ host, responseModel, responseEffort }) =>
    host === apiHost(api) && responseModel
      ? `${responseModel}${responseEffort ? `[effort=${responseEffort}]` : ''}`
      : undefined

/** What every route here shares: the key and where it goes. */
const keyed = (env: NodeJS.ProcessEnv, api: GatewayApi) => ({
  credential: vercelCredential(env),
  authAs: VERCEL_KEY,
  hosts: [apiHost(api)],
})

/**
 * Claude Code with `ANTHROPIC_BASE_URL` at the gateway: its adapter switches to it when given the
 * key as `AI_GATEWAY_API_KEY`, at `AI_GATEWAY_BASE_URL`, and the CLI sends it in `x-api-key` on
 * Anthropic's message paths. On another base URL than Anthropic's it makes none of its
 * `/api/claude_code/*` calls.
 */
function claudeCode(env: NodeJS.ProcessEnv): GatewayRoute {
  const api = vercelApi(env)
  return {
    ...keyed(env, api),
    endpoints: [
      on(api, anthropicPath(api, '/v1/messages'), 'POST'),
      on(api, anthropicPath(api, '/v1/messages/count_tokens'), 'POST'),
    ],
    ...(env[VERCEL_BASE_URL] ? { authEnv: { [VERCEL_BASE_URL]: api.anthropic } } : {}),
  }
}

/** Codex on a Responses API provider at Vercel, whose ids name the provider (`openai/…`). */
function codex(env: NodeJS.ProcessEnv): GatewayRoute {
  const api = vercelApi(env)
  const endpoints = [on(api, openaiPath(api, '/responses'), 'POST')]
  return {
    ...keyed(env, api),
    endpoints,
    modelResponses: endpoints,
    servedModel: servedOn(api),
    modelId: (model) => (model.includes('/') ? model : `openai/${model}`),
  }
}

/** fx's language-model calls on the gateway, whose responses name the model that served them. */
export const fxVercelCall = (api: GatewayApi = VERCEL_API) =>
  ({
    host: apiHost(api),
    path: { regex: `^${escaped(new URL(api.origin).pathname)}/v\\d+/ai/language-model$` },
    method: ['POST'],
  }) as const satisfies EndpointMatch

const escaped = (path: string) => path.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The model an fx call asked the gateway for, in `ai-language-model-id`: what reeval records when
 * a provider's stream (Gemini's) names no served model. Only a call that succeeded asked anything.
 */
export const fxAskedModel =
  (api: GatewayApi = VERCEL_API): NonNullable<ModelSpecific['servedModel']> =>
  (request) => {
    const call = fxVercelCall(api)
    if (request.host !== call.host || !new RegExp(call.path.regex).test(request.path))
      return undefined
    if (request.status === undefined || request.status < 200 || request.status > 299)
      return undefined
    const asked = request.headers?.['ai-language-model-id']
    return (typeof asked === 'string' ? asked : asked?.[0]) || undefined
  }

/** The model list fx fetches before a turn, and its language-model calls. */
export const fxVercelEndpoints = (api: GatewayApi = VERCEL_API) =>
  [
    {
      host: apiHost(api),
      path: { regex: `^${escaped(new URL(api.origin).pathname)}/coding-agent/v1/` },
      method: ['GET'],
    },
    fxVercelCall(api),
  ] as const satisfies readonly EndpointMatch[]

/** fx on its own AI Gateway provider, which takes a gateway id; a bare one is OpenAI's. */
function fx(env: NodeJS.ProcessEnv): GatewayRoute {
  const api = vercelApi(env)
  return {
    ...keyed(env, api),
    endpoints: fxVercelEndpoints(api),
    modelResponses: [fxVercelCall(api)],
    servedModel: servedOn(api),
    askedModel: fxAskedModel(api),
    modelId: (model) => (model.includes('/') ? model : `openai/${model}`),
  }
}

/**
 * Goose on its `vercel_ai_gateway` provider, an OpenAI-compatible one: Chat Completions, the
 * Responses API for OpenAI's reasoning models, and the model list it fetches each turn.
 */
function goose(env: NodeJS.ProcessEnv): GatewayRoute {
  const api = vercelApi(env)
  const calls = [
    on(api, openaiPath(api, '/chat/completions'), 'POST'),
    on(api, openaiPath(api, '/responses'), 'POST'),
  ]
  return {
    ...keyed(env, api),
    endpoints: [...calls, on(api, openaiPath(api, '/models'), 'GET')],
    modelResponses: calls,
    servedModel: servedOn(api),
    modelId: (model) => model,
  }
}

/**
 * pi on a provider of its own on Vercel, a Bearer key: an Anthropic model on the Anthropic
 * Messages API, any other on Chat Completions. A Gemini model's thinking level goes as Gemini's
 * own `thinkingConfig` under Vercel's `providerOptions` (Vercel's `reasoning_effort` maps every
 * Gemini 3 level but `low` to `high`).
 */
function pi(env: NodeJS.ProcessEnv): GatewayRoute {
  const api = vercelApi(env)
  const endpoints = [
    on(api, openaiPath(api, '/chat/completions'), 'POST'),
    on(api, anthropicPath(api, '/v1/messages'), 'POST'),
  ]
  return {
    ...keyed(env, api),
    endpoints,
    modelResponses: endpoints,
    servedModel: servedOn(api),
    modelId: (model) => model,
  }
}

/**
 * OpenCode on its own `vercel` provider, with the model as `vercel/<id>`: the requests the pinned
 * CLI sends that provider's key on (harness-opencode's provider table), plus Exa's host for web
 * search.
 */
function opencode(env: NodeJS.ProcessEnv): GatewayRoute {
  const resolved = resolveOpenCodeProvider('vercel/model')
  if ('error' in resolved) throw new Error(resolved.error)
  const { provider } = resolved
  return {
    credential: vercelCredential(env),
    authAs: VERCEL_KEY,
    endpoints: providerEndpoints(provider),
    modelResponses: providerModelResponses(provider),
    servedModel: (request) => providerServedModel(provider, request),
    hosts: [...providerHosts(provider), 'mcp.exa.ai'],
    modelId: (model) => `vercel/${model}`,
  }
}

/**
 * Grok Build with the model as a `[model.<id>]` table on Vercel's Chat Completions API, keyed by
 * `env_key`; it then calls nothing on xAI's API.
 */
function grokBuild(env: NodeJS.ProcessEnv): GatewayRoute {
  const api = vercelApi(env)
  const endpoints = [on(api, openaiPath(api, '/chat/completions'), 'POST')]
  return {
    ...keyed(env, api),
    endpoints,
    modelResponses: endpoints,
    servedModel: servedOn(api),
    // Grok probes its base URL's root without a credential, and Vercel redirects that to its site.
    ...(api === VERCEL_API
      ? {
          expectedBlocked: {
            hosts: ['vercel.com'],
            why: "Grok Build's probe of the gateway's root, which Vercel redirects to its site",
          },
        }
      : {}),
    modelId: (model) => (model.includes('/') ? model : `xai/${model}`),
  }
}

/** Why a harness can't follow `AI_GATEWAY_BASE_URL`, as `why` says: its calls stay on Vercel's host. */
const fixedUrl = (why: string) => (env: NodeJS.ProcessEnv) =>
  env[VERCEL_BASE_URL]
    ? `${why}, so reeval can't send its calls to ${VERCEL_BASE_URL} (${vercelApi(env).origin})`
    : undefined

/** Vercel AI Gateway: the harnesses reeval runs there, and why it doesn't run the rest. */
export const VERCEL_GATEWAY: RoutingGateway = {
  name: 'Vercel AI Gateway',
  api: vercelApi,
  routes: {
    'claude-code': claudeCode,
    codex,
    goose,
    opencode,
    fx,
    'grok-build': grokBuild,
    pi,
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
