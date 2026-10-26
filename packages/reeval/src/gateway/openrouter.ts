// OpenRouter as a route for a harness's model calls: the key it takes, the requests the egress
// gateway brokers it on, the model ids it names, and the upstream provider it says served each
// call. One key serves every harness here.
import {
  providerEndpoints,
  providerHosts,
  providerModelResponses,
  providerServedModel,
  resolveOpenCodeProvider,
} from '@reeval/harness-opencode/providers'
import type { EndpointMatch } from '@reeval/sandbox-docker'
import type { ServedModel, Upstream } from '../harness/agents.ts'
import { everyModel, notGemini } from './effort.ts'
import type { GatewayRoute, RoutingGateway } from './routes.ts'

export const OPENROUTER_HOST = 'openrouter.ai'
export const OPENROUTER_KEY = 'OPENROUTER_API_KEY'

const onOpenRouter = (path: string, method: 'GET' | 'POST' = 'POST') =>
  ({
    host: OPENROUTER_HOST,
    path: { exact: path },
    method: [method],
  }) as const satisfies EndpointMatch

/** The response names the model that served it on OpenRouter's host, in OpenRouter's form. */
export const servedOnOpenRouter: ServedModel = ({ host, responseModel, responseEffort }) =>
  host === OPENROUTER_HOST && responseModel
    ? `${responseModel}${responseEffort ? `[effort=${responseEffort}]` : ''}`
    : undefined

/** The upstream provider OpenRouter's response says served the call, and what it charged. */
export const upstreamOnOpenRouter: Upstream = ({ host, responseProvider, responseCost }) =>
  host === OPENROUTER_HOST && responseProvider
    ? {
        provider: responseProvider,
        ...(responseCost !== undefined ? { costUsd: responseCost } : {}),
      }
    : undefined

/** What every OpenRouter route shares: the key under its own name, and what the responses say. */
const route = (endpoints: readonly EndpointMatch[], calls: readonly EndpointMatch[]) => ({
  credential: OPENROUTER_KEY,
  authAs: OPENROUTER_KEY,
  endpoints,
  modelResponses: calls,
  servedModel: servedOnOpenRouter,
  upstream: upstreamOnOpenRouter,
  hosts: [OPENROUTER_HOST],
})

/** An id as OpenRouter names it: as written when it names a provider, else under `provider`. */
const under = (provider: string) => (model: string) =>
  model.includes('/') ? model : `${provider}/${model}`

/**
 * An Anthropic id as OpenRouter names it, with the version dotted (`anthropic/claude-haiku-4.5`
 * for `claude-haiku-4-5`), unless the id names a provider.
 */
export const anthropicOnOpenRouter = (model: string) =>
  model.includes('/') ? model : `anthropic/${model.replace(/-(\d{1,2})-(\d{1,2})$/, '-$1.$2')}`

/**
 * Claude Code on OpenRouter's Anthropic Messages API: `ANTHROPIC_BASE_URL` at OpenRouter and the
 * key as `ANTHROPIC_AUTH_TOKEN`, which the CLI sends as a Bearer token. On another base URL it
 * makes none of its `/api/claude_code/*` calls.
 */
function claudeCode(): GatewayRoute {
  const calls = [onOpenRouter('/api/v1/messages')]
  return {
    ...route([...calls, onOpenRouter('/api/v1/messages/count_tokens')], calls),
    authAs: 'ANTHROPIC_AUTH_TOKEN',
    authEnv: { ANTHROPIC_BASE_URL: `https://${OPENROUTER_HOST}/api` },
    modelId: anthropicOnOpenRouter,
  }
}

/** Codex on a Responses API provider at OpenRouter, whose ids name the provider (`openai/…`). */
function codex(): GatewayRoute {
  const calls = [onOpenRouter('/api/v1/responses')]
  return { ...route(calls, calls), modelId: under('openai') }
}

/**
 * Goose on its `openrouter` provider: Chat Completions, and the model list it fetches each turn.
 */
function goose(): GatewayRoute {
  const calls = [onOpenRouter('/api/v1/chat/completions')]
  return {
    ...route([...calls, onOpenRouter('/api/v1/models', 'GET')], calls),
    modelId: under('google'),
  }
}

/**
 * OpenCode on its own `openrouter` provider, with the model as `openrouter/<id>`: the requests the
 * pinned CLI sends that provider's key on (harness-opencode's provider table), plus Exa's host for
 * web search.
 */
function opencode(): GatewayRoute {
  const resolved = resolveOpenCodeProvider('openrouter/model')
  if ('error' in resolved) throw new Error(resolved.error)
  const { provider } = resolved
  return {
    credential: OPENROUTER_KEY,
    authAs: OPENROUTER_KEY,
    endpoints: providerEndpoints(provider),
    modelResponses: providerModelResponses(provider),
    servedModel: (request) => providerServedModel(provider, request),
    upstream: upstreamOnOpenRouter,
    hosts: [...providerHosts(provider), 'mcp.exa.ai'],
    modelId: (model) => `openrouter/${model}`,
  }
}

/**
 * pi on its own `openrouter` provider: Chat Completions, a Bearer key, a model from pi's catalog
 * for OpenRouter, each thinking level sent as OpenRouter's `reasoning.effort`. `--offline` skips
 * the model list pi would fetch to fit that catalog to the key.
 */
function pi(): GatewayRoute {
  const calls = [onOpenRouter('/api/v1/chat/completions')]
  return { ...route(calls, calls), modelId: under('google') }
}

/**
 * Grok Build with the model as a `[model.<id>]` table on OpenRouter's Chat Completions API, keyed
 * by `env_key`; it then calls nothing on xAI's API.
 */
function grokBuild(): GatewayRoute {
  const calls = [onOpenRouter('/api/v1/chat/completions')]
  return { ...route(calls, calls), modelId: under('x-ai') }
}

/** OpenRouter: the harnesses reeval runs there, and why it doesn't run the rest. */
export const OPENROUTER_GATEWAY: RoutingGateway = {
  name: 'OpenRouter',
  routes: {
    'claude-code': claudeCode,
    codex,
    goose,
    opencode,
    'grok-build': grokBuild,
    pi,
  },
  refusals: {
    cursor: "Cursor's agent only calls Cursor's own API",
    antigravity:
      "Antigravity's CLI only calls Google's API, with a Gemini key, and OpenRouter has no Gemini API",
    fx: "fx reaches models only on Vercel AI Gateway or OpenAI's API, and no run has checked it on OpenRouter",
  },
  // Codex's response names the effort it ran at; Goose, OpenCode and pi send OpenRouter's
  // reasoning.effort, which it sends a Gemini model as its thinking level, and Grok Build
  // reasoning_effort (an xAI model's own). Claude Code sends Anthropic's adaptive thinking and effort, which
  // OpenRouter turns into a thinking budget for a model that takes neither (Haiku 4.5).
  unprovenEffort: { 'claude-code': everyModel, goose: notGemini, opencode: notGemini },
}
