// OpenRouter's routes as the egress gateway sees them: the variable each adapter takes the key as,
// the requests it brokers it on, and the upstream provider it says served each call. The key, the
// model ids and the refusals are @reeval/agents' `OPENROUTER_ROUTE`.
import {
  anthropicPath,
  OPENROUTER_API,
  OPENROUTER_HOST,
  OPENROUTER_KEY,
  OPENROUTER_ROUTE,
  openaiPath,
} from '@reeval/agents'
import {
  providerEndpoints,
  providerHosts,
  providerModelResponses,
  providerServedModel,
  resolveOpenCodeProvider,
} from '@reeval/harness-opencode/providers'
import type { EndpointMatch } from '@reeval/sandbox-docker'
import { servedOnOpenRouter, upstreamOnOpenRouter } from '../environment/harness-wire.ts'
import type { RouteWire, RoutingGateway } from './routes.ts'
import { withWire } from './with-wire.ts'

export {
  anthropicOnOpenRouter,
  OPENROUTER_KEY,
} from '@reeval/agents'
export { servedOnOpenRouter, upstreamOnOpenRouter }

const openai = (endpoint: string) => openaiPath(OPENROUTER_API, endpoint)

const onOpenRouter = (path: string, method: 'GET' | 'POST' = 'POST') =>
  ({
    host: OPENROUTER_HOST,
    path: { exact: path },
    method: [method],
  }) as const satisfies EndpointMatch

/** What every OpenRouter route shares: the key under its own name, and what the responses say. */
const route = (endpoints: readonly EndpointMatch[], calls: readonly EndpointMatch[]) => ({
  authAs: OPENROUTER_KEY,
  endpoints,
  modelResponses: calls,
  servedModel: servedOnOpenRouter,
  upstream: upstreamOnOpenRouter,
  hosts: [OPENROUTER_HOST],
})

/**
 * Claude Code on OpenRouter's Anthropic Messages API: `ANTHROPIC_BASE_URL` at OpenRouter and the
 * key as `ANTHROPIC_AUTH_TOKEN`, which the CLI sends as a Bearer token. On another base URL it
 * makes none of its `/api/claude_code/*` calls.
 */
function claudeCode(): RouteWire {
  const calls = [onOpenRouter(anthropicPath(OPENROUTER_API, '/v1/messages'))]
  return {
    ...route(
      [...calls, onOpenRouter(anthropicPath(OPENROUTER_API, '/v1/messages/count_tokens'))],
      calls,
    ),
    authAs: 'ANTHROPIC_AUTH_TOKEN',
    authEnv: { ANTHROPIC_BASE_URL: OPENROUTER_API.anthropic },
  }
}

/** Codex on a Responses API provider at OpenRouter, whose ids name the provider (`openai/…`). */
function codex(): RouteWire {
  const calls = [onOpenRouter(openai('/responses'))]
  return route(calls, calls)
}

/**
 * Goose on its `openrouter` provider: Chat Completions, and the model list it fetches each turn.
 */
function goose(): RouteWire {
  const calls = [onOpenRouter(openai('/chat/completions'))]
  return route([...calls, onOpenRouter(openai('/models'), 'GET')], calls)
}

/**
 * OpenCode on its own `openrouter` provider, with the model as `openrouter/<id>`: the requests the
 * pinned CLI sends that provider's key on (harness-opencode's provider table), plus Exa's host for
 * web search.
 */
function opencode(): RouteWire {
  const resolved = resolveOpenCodeProvider('openrouter/model')
  if ('error' in resolved) throw new Error(resolved.error)
  const { provider } = resolved
  return {
    authAs: OPENROUTER_KEY,
    endpoints: providerEndpoints(provider),
    modelResponses: providerModelResponses(provider),
    servedModel: (request) => providerServedModel(provider, request),
    upstream: upstreamOnOpenRouter,
    hosts: [...providerHosts(provider), 'mcp.exa.ai'],
  }
}

/**
 * pi on a provider of its own on OpenRouter, a Bearer key: an Anthropic model on the Anthropic
 * Messages API, any other on Chat Completions. A Gemini model runs on pi's own `openrouter`
 * provider instead, whose thinking level goes as OpenRouter's `reasoning.effort`. `--offline`
 * skips the model list pi would fetch to fit its catalog to the key.
 */
function pi(): RouteWire {
  const calls = [
    onOpenRouter(openai('/chat/completions')),
    onOpenRouter(anthropicPath(OPENROUTER_API, '/v1/messages')),
  ]
  return route(calls, calls)
}

/**
 * Grok Build with the model as a `[model.<id>]` table on OpenRouter's Chat Completions API, keyed
 * by `env_key`; it then calls nothing on xAI's API.
 */
function grokBuild(): RouteWire {
  const calls = [onOpenRouter(openai('/chat/completions'))]
  return route(calls, calls)
}

/**
 * fx with OpenRouter's Chat Completions API as its configured provider `openrouter`, through the
 * relay, and an OpenAI id as `openai/<id>`. fx sends no `reasoning_effort` to a configured provider.
 */
function fx(): RouteWire {
  const calls = [onOpenRouter(openai('/chat/completions'))]
  return route(calls, calls)
}

/** OpenRouter: the harnesses reeval runs there, and why it doesn't run the rest. */
export const OPENROUTER_GATEWAY: RoutingGateway = withWire(OPENROUTER_ROUTE, {
  'claude-code': claudeCode,
  codex,
  goose,
  opencode,
  fx,
  'grok-build': grokBuild,
  pi,
})
