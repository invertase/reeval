// Vercel AI Gateway as a route for a harness's model calls: the key it takes, the requests the
// egress gateway brokers it on, and the model ids it names. One key serves every harness here.
import type { EndpointMatch } from '@reeval/sandbox-docker'
import type { AgentKind, ModelSpecific } from '../harness/agents.ts'

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
const servedOnVercel: ModelSpecific['servedModel'] = ({ host, responseModel, responseEffort }) =>
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

/** pi on its `vercel-ai-gateway` provider, Anthropic's Messages API at Vercel's host. */
function pi(env: NodeJS.ProcessEnv): VercelRoute {
  const endpoints = [onVercel('/v1/messages', 'POST')]
  return {
    credential: vercelCredential(env),
    authAs: VERCEL_KEY,
    endpoints,
    modelResponses: endpoints,
    servedModel: servedOnVercel,
    hosts: [VERCEL_HOST],
    modelId: googleId,
  }
}

/** The harnesses reeval runs on Vercel, and what each needs there. */
export const VERCEL_ROUTES: Partial<Record<AgentKind, (env: NodeJS.ProcessEnv) => VercelRoute>> = {
  'claude-code': claudeCode,
  codex,
  goose,
  pi,
}

/** Why Vercel can't serve an agent reeval doesn't route there, for the plan's messages. */
export const VERCEL_REFUSALS: Partial<Record<AgentKind, string>> = {
  cursor: "Cursor's agent only calls Cursor's own API",
  antigravity: "Antigravity's CLI only calls Google's API, with a Gemini key",
}
