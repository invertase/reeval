// Vercel AI Gateway as a route for a harness's model calls: the key it takes, the requests the
// egress gateway brokers it on, and the model ids it names. One key serves every harness here.
import {
  providerEndpoints,
  providerHosts,
  providerModelResponses,
  providerServedModel,
  resolveOpenCodeProvider,
} from '@reeval/harness-opencode/providers'
import type { EndpointMatch } from '@reeval/sandbox-docker'
import type { AgentKind, ExpectedBlocked, ModelSpecific } from '../harness/agents.ts'

export const VERCEL_HOST = 'ai-gateway.vercel.sh'

/** What the adapters take Vercel's key as, whichever host variable it came from. */
export const VERCEL_KEY = 'AI_GATEWAY_API_KEY'
/** A Vercel project's short-lived token (`vercel env pull`), used when there's no key. */
export const VERCEL_OIDC = 'VERCEL_OIDC_TOKEN'

/** What a harness on Vercel needs besides its usual catalog entry. */
export type VercelRoute = ModelSpecific & {
  /** The variable the adapter takes the key as. */
  authAs: string
  /** The model id Vercel serves for the harness's own id. */
  modelId?: (model: string) => string
  /** The hosts the agent tries on Vercel and is refused, in place of its catalog entry's. */
  expectedBlocked?: ExpectedBlocked
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

const onVercel = (path: string, method: 'GET' | 'POST') =>
  ({ host: VERCEL_HOST, path: { exact: path }, method: [method] }) as const satisfies EndpointMatch

/**
 * The response names the model that served it on Vercel's host, in Vercel's form
 * (`openai/gpt-5.6-luna`), with the reasoning effort when it says one.
 */
export const servedOnVercel: ModelSpecific['servedModel'] = ({
  host,
  responseModel,
  responseEffort,
}) =>
  host === VERCEL_HOST && responseModel
    ? `${responseModel}${responseEffort ? `[effort=${responseEffort}]` : ''}`
    : undefined

/**
 * Claude Code with `ANTHROPIC_BASE_URL` at Vercel's host: its adapter switches to it when given
 * the key as `AI_GATEWAY_API_KEY`, and the CLI sends it in `x-api-key` on Anthropic's message
 * paths. On another base URL it makes none of its `/api/claude_code/*` calls.
 */
function claudeCode(env: NodeJS.ProcessEnv): VercelRoute {
  return {
    credential: vercelCredential(env),
    authAs: VERCEL_KEY,
    endpoints: [onVercel('/v1/messages', 'POST'), onVercel('/v1/messages/count_tokens', 'POST')],
    hosts: [VERCEL_HOST],
  }
}

/** Codex on a Responses API provider at Vercel, whose ids name the provider (`openai/…`). */
function codex(env: NodeJS.ProcessEnv): VercelRoute {
  const endpoints = [onVercel('/v1/responses', 'POST')]
  return {
    credential: vercelCredential(env),
    authAs: VERCEL_KEY,
    endpoints,
    modelResponses: endpoints,
    servedModel: servedOnVercel,
    hosts: [VERCEL_HOST],
    modelId: (model) => (model.includes('/') ? model : `openai/${model}`),
  }
}

/** fx's language-model calls on Vercel, whose responses name the model that served them. */
export const FX_VERCEL_CALL = {
  host: VERCEL_HOST,
  path: { regex: '^/v\\d+/ai/language-model$' },
  method: ['POST'],
} as const satisfies EndpointMatch

/**
 * The model an fx call asked the gateway for, in `ai-language-model-id`: what reeval records when
 * a provider's stream (Gemini's) names no served model. Only a call that succeeded asked anything.
 */
export const fxAskedModel: ModelSpecific['servedModel'] = (request) => {
  if (request.host !== VERCEL_HOST || !new RegExp(FX_VERCEL_CALL.path.regex).test(request.path))
    return undefined
  if (request.status === undefined || request.status < 200 || request.status > 299) return undefined
  const asked = request.headers?.['ai-language-model-id']
  return (typeof asked === 'string' ? asked : asked?.[0]) || undefined
}

/** The model list fx fetches before a turn, and its language-model calls. */
export const FX_VERCEL_ENDPOINTS = [
  { host: VERCEL_HOST, path: { regex: '^/coding-agent/v1/' }, method: ['GET'] },
  FX_VERCEL_CALL,
] as const satisfies readonly EndpointMatch[]

/** fx on its own AI Gateway provider, which takes a gateway id; a bare one is OpenAI's. */
function fx(env: NodeJS.ProcessEnv): VercelRoute {
  return {
    credential: vercelCredential(env),
    authAs: VERCEL_KEY,
    endpoints: FX_VERCEL_ENDPOINTS,
    modelResponses: [FX_VERCEL_CALL],
    servedModel: servedOnVercel,
    askedModel: fxAskedModel,
    hosts: [VERCEL_HOST],
    modelId: (model) => (model.includes('/') ? model : `openai/${model}`),
  }
}

/** A Gemini id as Vercel names it (`google/gemini-3-flash`), unless the id names a provider. */
const googleId = (model: string) => (model.includes('/') ? model : `google/${model}`)

/**
 * Goose on its `vercel_ai_gateway` provider, an OpenAI-compatible one: Chat Completions, the
 * Responses API for OpenAI's reasoning models, and the model list it fetches each turn.
 */
function goose(env: NodeJS.ProcessEnv): VercelRoute {
  const calls = [onVercel('/v1/chat/completions', 'POST'), onVercel('/v1/responses', 'POST')]
  return {
    credential: vercelCredential(env),
    authAs: VERCEL_KEY,
    endpoints: [...calls, onVercel('/v1/models', 'GET')],
    modelResponses: calls,
    servedModel: servedOnVercel,
    hosts: [VERCEL_HOST],
    modelId: googleId,
  }
}

/**
 * OpenCode on its own `vercel` provider, with the model as `vercel/<id>`: the requests the pinned
 * CLI sends that provider's key on (harness-opencode's provider table), plus Exa's host for web
 * search.
 */
function opencode(env: NodeJS.ProcessEnv): VercelRoute {
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
function grokBuild(env: NodeJS.ProcessEnv): VercelRoute {
  const endpoints = [onVercel('/v1/chat/completions', 'POST')]
  return {
    credential: vercelCredential(env),
    authAs: VERCEL_KEY,
    endpoints,
    modelResponses: endpoints,
    servedModel: servedOnVercel,
    hosts: [VERCEL_HOST],
    // Grok probes its base URL's root without a credential, and Vercel redirects that to its site.
    expectedBlocked: {
      hosts: ['vercel.com'],
      why: "Grok Build's probe of the gateway's root, which Vercel redirects to its site",
    },
    modelId: (model) => (model.includes('/') ? model : `xai/${model}`),
  }
}

/** The harnesses reeval runs on Vercel, and what each needs there. */
export const VERCEL_ROUTES: Partial<Record<AgentKind, (env: NodeJS.ProcessEnv) => VercelRoute>> = {
  'claude-code': claudeCode,
  codex,
  goose,
  opencode,
  fx,
  'grok-build': grokBuild,
}

/** Why Vercel can't serve an agent reeval doesn't route there, for the plan's messages. */
export const VERCEL_REFUSALS: Partial<Record<AgentKind, string>> = {
  cursor: "Cursor's agent only calls Cursor's own API",
  antigravity: "Antigravity's CLI only calls Google's API, with a Gemini key",
  pi: "pi reaches a Gemini model on Vercel AI Gateway only through Anthropic's Messages API, with Anthropic's thinking budget for Gemini's own thinking level, and doesn't behave as it does on Gemini's API; reeval runs pi on its Gemini key",
}

/**
 * The harnesses on Vercel whose `effort` reaches the model by a path no real run has checked: the
 * plan refuses `effort` with them on `vercel()`. Claude Code's goes as on Anthropic's API, and
 * Codex's response names the effort it ran at.
 */
export const VERCEL_UNPROVEN_EFFORT: readonly AgentKind[] = ['goose', 'opencode', 'grok-build']
