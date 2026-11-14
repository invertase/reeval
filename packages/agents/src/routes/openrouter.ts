// OpenRouter as a route for a harness's model calls: the key it takes and the model ids it names.
// One key serves every harness here.
import { apiHost, type RouteApi } from './api.ts'
import { everyModel, notGemini } from './effort.ts'
import type { Route, RouteConfig } from './route.ts'

export const OPENROUTER_API: RouteApi = {
  origin: 'https://openrouter.ai',
  openai: 'https://openrouter.ai/api/v1',
  anthropic: 'https://openrouter.ai/api',
}

export const OPENROUTER_HOST = apiHost(OPENROUTER_API)

export const OPENROUTER_KEY = 'OPENROUTER_API_KEY'

/** An id as OpenRouter names it: as written when it names a provider, else under `provider`. */
const under = (provider: string) => (model: string) =>
  model.includes('/') ? model : `${provider}/${model}`

/**
 * An Anthropic id as OpenRouter names it, with the version dotted (`anthropic/claude-haiku-4.5`
 * for `claude-haiku-4-5`), unless the id names a provider.
 */
export const anthropicOnOpenRouter = (model: string) =>
  model.includes('/') ? model : `anthropic/${model.replace(/-(\d{1,2})-(\d{1,2})$/, '-$1.$2')}`

/** A harness on OpenRouter's key, under its own name, with the model id OpenRouter serves. */
const keyed = (modelId: (model: string) => string) => (): RouteConfig => ({
  credential: OPENROUTER_KEY,
  modelId,
})

/** OpenRouter: the harnesses reeval runs there, and why it doesn't run the rest. */
export const OPENROUTER_ROUTE: Route = {
  name: 'OpenRouter',
  api: () => OPENROUTER_API,
  routes: {
    'claude-code': keyed(anthropicOnOpenRouter),
    codex: keyed(under('openai')),
    goose: keyed((model) => model),
    opencode: keyed((model) => `openrouter/${model}`),
    fx: keyed(under('openai')),
    'grok-build': keyed(under('x-ai')),
    pi: keyed((model) => model),
  },
  refusals: {
    cursor: "Cursor's agent only calls Cursor's own API",
    antigravity:
      "Antigravity's CLI only calls Google's API, with a Gemini key, and OpenRouter has no Gemini API",
  },
  // Codex's response names the effort it ran at; Goose, OpenCode and pi send OpenRouter's
  // reasoning.effort, which it sends a Gemini model as its thinking level, and Grok Build
  // reasoning_effort (an xAI model's own). Claude Code sends Anthropic's adaptive thinking and effort, which
  // OpenRouter turns into a thinking budget for a model that takes neither (Haiku 4.5).
  unprovenEffort: {
    'claude-code': everyModel,
    goose: notGemini,
    opencode: notGemini,
    pi: notGemini,
  },
}
