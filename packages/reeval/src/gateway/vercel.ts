// Vercel AI Gateway's routes as the egress gateway sees them: the variable each adapter takes the
// key as and the requests it brokers it on. The key, the model ids and the refusals are
// @reeval/agents' `VERCEL_ROUTE`.
import {
  anthropicPath,
  apiHost,
  openaiPath,
  type RouteApi,
  VERCEL_API,
  VERCEL_BASE_URL,
  VERCEL_KEY,
  VERCEL_ROUTE,
  vercelApi,
} from '@reeval/agents'
import {
  providerEndpoints,
  providerHosts,
  providerModelResponses,
  providerServedModel,
  resolveOpenCodeProvider,
} from '@reeval/harness-opencode/providers'
import type { EndpointMatch } from '@reeval/sandbox-docker'
import {
  fxAskedModel,
  fxVercelCall,
  fxVercelEndpoints,
  servedOn,
} from '../environment/harness-wire.ts'
import type { RouteWire, RoutingGateway } from './routes.ts'
import { withWire } from './with-wire.ts'

export {
  VERCEL_BASE_URL,
  VERCEL_KEY,
  VERCEL_OIDC,
  vercelApi,
  vercelBaseUrl,
  vercelBaseUrlProblem,
  vercelCredential,
  vercelCredentialProblem,
} from '@reeval/agents'
export { fxAskedModel, fxVercelCall, fxVercelEndpoints, servedOn }

const on = (api: RouteApi, path: string, method: 'GET' | 'POST') =>
  ({ host: apiHost(api), path: { exact: path }, method: [method] }) as const satisfies EndpointMatch

/** What every route here shares: the variable the adapters take the key as, and where it goes. */
const keyed = (api: RouteApi) => ({
  authAs: VERCEL_KEY,
  hosts: [apiHost(api)],
})

/**
 * Claude Code with `ANTHROPIC_BASE_URL` at the gateway: its adapter switches to it when given the
 * key as `AI_GATEWAY_API_KEY`, at `AI_GATEWAY_BASE_URL`, and the CLI sends it in `x-api-key` on
 * Anthropic's message paths. On another base URL than Anthropic's it makes none of its
 * `/api/claude_code/*` calls.
 */
function claudeCode(env: NodeJS.ProcessEnv): RouteWire {
  const api = vercelApi(env)
  return {
    ...keyed(api),
    endpoints: [
      on(api, anthropicPath(api, '/v1/messages'), 'POST'),
      on(api, anthropicPath(api, '/v1/messages/count_tokens'), 'POST'),
    ],
    ...(env[VERCEL_BASE_URL] ? { authEnv: { [VERCEL_BASE_URL]: api.anthropic } } : {}),
  }
}

/** Codex on a Responses API provider at Vercel, whose ids name the provider (`openai/…`). */
function codex(env: NodeJS.ProcessEnv): RouteWire {
  const api = vercelApi(env)
  const endpoints = [on(api, openaiPath(api, '/responses'), 'POST')]
  return {
    ...keyed(api),
    endpoints,
    modelResponses: endpoints,
    servedModel: servedOn(api),
  }
}

/** fx on its own AI Gateway provider, which takes a gateway id; a bare one is OpenAI's. */
function fx(env: NodeJS.ProcessEnv): RouteWire {
  const api = vercelApi(env)
  return {
    ...keyed(api),
    endpoints: fxVercelEndpoints(api),
    modelResponses: [fxVercelCall(api)],
    servedModel: servedOn(api),
    askedModel: fxAskedModel(api),
  }
}

/**
 * Goose on its `vercel_ai_gateway` provider, an OpenAI-compatible one: Chat Completions, the
 * Responses API for OpenAI's reasoning models, and the model list it fetches each turn.
 */
function goose(env: NodeJS.ProcessEnv): RouteWire {
  const api = vercelApi(env)
  const calls = [
    on(api, openaiPath(api, '/chat/completions'), 'POST'),
    on(api, openaiPath(api, '/responses'), 'POST'),
  ]
  return {
    ...keyed(api),
    endpoints: [...calls, on(api, openaiPath(api, '/models'), 'GET')],
    modelResponses: calls,
    servedModel: servedOn(api),
  }
}

/**
 * pi on a provider of its own on Vercel, a Bearer key: an Anthropic model on the Anthropic
 * Messages API, any other on Chat Completions. A Gemini model's thinking level goes as Gemini's
 * own `thinkingConfig` under Vercel's `providerOptions` (Vercel's `reasoning_effort` maps every
 * Gemini 3 level but `low` to `high`).
 */
function pi(env: NodeJS.ProcessEnv): RouteWire {
  const api = vercelApi(env)
  const endpoints = [
    on(api, openaiPath(api, '/chat/completions'), 'POST'),
    on(api, anthropicPath(api, '/v1/messages'), 'POST'),
  ]
  return {
    ...keyed(api),
    endpoints,
    modelResponses: endpoints,
    servedModel: servedOn(api),
  }
}

/**
 * OpenCode on its own `vercel` provider, with the model as `vercel/<id>`: the requests the pinned
 * CLI sends that provider's key on (harness-opencode's provider table), plus Exa's host for web
 * search.
 */
function opencode(): RouteWire {
  const resolved = resolveOpenCodeProvider('vercel/model')
  if ('error' in resolved) throw new Error(resolved.error)
  const { provider } = resolved
  return {
    authAs: VERCEL_KEY,
    endpoints: providerEndpoints(provider),
    modelResponses: providerModelResponses(provider),
    servedModel: (request) => providerServedModel(provider, request),
    hosts: [...providerHosts(provider), 'mcp.exa.ai'],
  }
}

/**
 * Grok Build with the model as a `[model.<id>]` table on Vercel's Chat Completions API, keyed by
 * `env_key`; it then calls nothing on xAI's API.
 */
function grokBuild(env: NodeJS.ProcessEnv): RouteWire {
  const api = vercelApi(env)
  const endpoints = [on(api, openaiPath(api, '/chat/completions'), 'POST')]
  return {
    ...keyed(api),
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
  }
}

/** Vercel AI Gateway: the harnesses reeval runs there, and why it doesn't run the rest. */
export const VERCEL_GATEWAY: RoutingGateway = withWire(VERCEL_ROUTE, {
  'claude-code': claudeCode,
  codex,
  goose,
  opencode,
  fx,
  'grok-build': grokBuild,
  pi,
})
