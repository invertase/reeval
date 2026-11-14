// What reeval's egress gateway needs to know about each harness's agent: the requests it brokers
// the credential on, the model calls it times, the hosts the agent tries, and the model a
// response names. The agent's own catalog entry, in @reeval/agents, knows none of it.
import type { AgentKind } from '@reeval/agents'
import { providerOf } from '@reeval/agents'
import {
  providerEndpoints,
  providerHosts,
  providerModelResponses,
  providerServedModel,
  resolveOpenCodeProvider,
} from '@reeval/harness-opencode/providers'
import { type PiProvider, piProvider } from '@reeval/harness-pi/providers'
import type { DerivedTokens, EndpointMatch, LocalResponse } from '@reeval/sandbox-docker'
import type { BrokeredToken } from '../gateway/token.ts'
import {
  fxAskedModel,
  fxVercelCall,
  fxVercelEndpoints,
  servedOn,
  VERCEL_HOST,
  VERCEL_KEY,
} from '../gateway/vercel.ts'
import type { SandboxAdc, VertexChat } from '../gateway/vertex.ts'
import type { Agent } from '../harness/agents.ts'
import { InfraError } from '../sandbox/types.ts'

/** What the egress gateway and an agent's route add to its catalog entry. */
export type HarnessWire = {
  /**
   * A short-lived token reeval mints on the host (Vertex AI's Google Cloud access token), which
   * the egress gateway adds to the agent's requests and replaces before it expires, in place of
   * `credential` from the environment.
   */
  token?: BrokeredToken
  /** Variables the adapter sets for the agent on its gateway's route (Vertex's project and region). */
  routeEnv?: Record<string, string>
  /** The service account the agent's CLI reads on Vertex, written beside the workspace. */
  adc?: SandboxAdc
  /** Requests the egress gateway answers itself on the agent's route (Vertex's token exchange). */
  localResponses?: readonly LocalResponse[]
  /** Where Vertex's Chat Completions API is, for an agent that calls it on Vertex (Grok Build). */
  vertexChat?: VertexChat
  /**
   * The variable the adapter takes the credential as, when not its own name: a gateway's key, or
   * the one the CLI reads (pi reads Google's key as `GEMINI_API_KEY`).
   */
  authAs?: string
  /** Variables the adapter takes beside the credential, such as the base URL a gateway sets. */
  authEnv?: Readonly<Record<string, string>>
  /**
   * The only requests the egress gateway swaps the credential into, whatever rules the adapter
   * asks for. Anything else carrying the placeholder gets a 403 from the gateway.
   */
  endpoints: readonly EndpointMatch[]
  /**
   * Session tokens the agent's CLI gets for its credential, which the gateway keeps out of the
   * sandbox too: the exchange's response carries placeholders, swapped back on these hosts.
   */
  tokens?: Omit<DerivedTokens, 'name'>
  /**
   * Hosts the agent's CLI always tries and nothing needs, which no setting turns off. A
   * restricted policy still refuses them, but reeval records them apart from the real blocks and
   * `-v` summarizes them once instead of a line per request.
   */
  expectedBlocked?: ExpectedBlocked
  /**
   * The model a brokered request asks the agent's API for, e.g. from its URL; unset when the
   * requests don't say (Cursor's are protobuf), so the record says it's unknown.
   */
  servedModel?: ServedModel
  /**
   * The model a successful request asked for, when neither it nor its response names the one that
   * served it; recorded as `askedModels`, never as served.
   */
  askedModel?: ServedModel
  /** Requests whose response body names the model that served them, for `servedModel`. */
  modelResponses?: readonly EndpointMatch[]
  /**
   * The agent's model calls besides `modelResponses` (which are model calls too): the egress
   * gateway times each one and reads its tokens, for the transcript's `model-call` events.
   */
  modelCalls?: readonly EndpointMatch[]
  /** Set when one model call carries a whole turn, its tool calls inside it (Cursor's stream). */
  modelStream?: true
  /**
   * The upstream provider a gateway's response says served a call (OpenRouter's), and what it
   * charged; unset where the response names none.
   */
  upstream?: Upstream
  /**
   * Hosts a restricted egress policy allows for it, in place of its image's (`HARNESS_HOSTS`);
   * set by `forModel` for an agent whose hosts depend on the model's provider.
   */
  hosts?: readonly string[]
  /**
   * What depends on the model, for an agent that runs on several providers (OpenCode): the
   * model's provider's credential, endpoints, hosts and served-model reader, with hosts built from
   * the host's variables (Bedrock's `AWS_REGION`). Throws an `InfraError` naming why a model can't
   * run.
   */
  forModel?: (model: string, env?: NodeJS.ProcessEnv) => ModelSpecific
}

/** The part of an agent's catalog entry its model's provider decides. */
export type ModelSpecific = Pick<
  Agent,
  'credential' | 'authAs' | 'endpoints' | 'servedModel' | 'askedModel' | 'upstream'
> & {
  modelResponses?: readonly EndpointMatch[]
  modelCalls?: readonly EndpointMatch[]
  hosts: readonly string[]
}

/** A harness's known noise: the hosts, and what they are, for the `-v` summary. */
export type ExpectedBlocked = {
  hosts: readonly string[]
  why: string
  /** Tried only in a session given plugins; another session's attempt on these hosts is a real block. */
  withPlugins?: true
}

/**
 * The model a successful brokered request names, from its method, host and path; undefined when
 * it names none.
 */
export type ServedModel = (request: BrokeredRequest) => string | undefined

/** A successful brokered request, as the egress gateway saw it. */
export type BrokeredRequest = {
  method: string
  host: string
  path: string
  status?: number
  /** What the response body said served it, on a `modelResponses` endpoint. */
  responseModel?: string
  /** The reasoning effort the response body said it ran at, on a `modelResponses` endpoint. */
  responseEffort?: string
  /** The upstream provider the response body said served it, on a `modelResponses` endpoint. */
  responseProvider?: string
  /** The last `"cost"` the response body named, on a `modelResponses` endpoint. */
  responseCost?: number
  /** The request's headers, as the agent sent them. */
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>
}

/**
 * The upstream provider a gateway says served a brokered request, with what it charged in US
 * dollars when it says; undefined when it names none.
 */
export type Upstream = (
  request: BrokeredRequest,
) => { provider: string; costUsd?: number } | undefined

/** A Gemini API key's only request: `POST /v1beta/models/<model>:streamGenerateContent`. */
const GEMINI_ENDPOINTS = [
  {
    host: 'generativelanguage.googleapis.com',
    path: { regex: '^/v1beta/models/[^/]+:streamGenerateContent$' },
    method: ['POST'],
  },
] as const satisfies readonly EndpointMatch[]

/** Antigravity's: its model calls, and the `:generateContent` call its `search_web` tool makes. */
const ANTIGRAVITY_ENDPOINTS = [
  {
    host: 'generativelanguage.googleapis.com',
    path: { regex: '^/v1beta/models/[\\w.-]+:(?:streamGenerateContent|generateContent)$' },
    method: ['POST'],
  },
] as const satisfies readonly EndpointMatch[]

/** Goose's: the model call, and the model list it fetches with the key at the start of a turn. */
const GOOSE_ENDPOINTS = [
  ...GEMINI_ENDPOINTS,
  {
    host: 'generativelanguage.googleapis.com',
    path: { regex: '^/v1beta/models$' },
    method: ['GET'],
  },
] as const satisfies readonly EndpointMatch[]

/**
 * What Grok Build sends the key on: the model list and the key's status as a session starts, and
 * its model calls (Chat Completions, and the Responses API for a model or tool that takes it).
 */
const XAI_ENDPOINTS = [
  { host: 'api.x.ai', path: { exact: '/v1/models' }, method: ['GET'] },
  { host: 'api.x.ai', path: { exact: '/v1/api-key' }, method: ['GET'] },
  { host: 'api.x.ai', path: { exact: '/v1/chat/completions' }, method: ['POST'] },
  { host: 'api.x.ai', path: { exact: '/v1/responses' }, method: ['POST'] },
] as const satisfies readonly EndpointMatch[]

/** xAI's model calls, whose responses name the model that served them. */
const XAI_MODEL_RESPONSES = XAI_ENDPOINTS.filter(
  (e) => e.path.exact === '/v1/chat/completions' || e.path.exact === '/v1/responses',
)

/** The model an xAI response says served it. */
const xaiServedModel: ServedModel = ({ host, responseModel }) =>
  host === 'api.x.ai' ? responseModel : undefined

/** The model a Gemini API request names in its URL. */
const geminiServedModel: ServedModel = ({ host, path }) =>
  host === 'generativelanguage.googleapis.com'
    ? /^\/v1beta\/models\/([^/:]+):streamGenerateContent$/.exec(path)?.[1]
    : undefined

/** Cursor's agent stream: one call per turn, which carries the turn's model output and tool calls. */
const CURSOR_RUN = {
  host: 'api2.cursor.sh',
  path: { exact: '/agent.v1.AgentService/RunSSE' },
  method: ['POST'],
} as const satisfies EndpointMatch

/** Cursor's key exchange: the only request the Cursor SDK sends the API key on. */
const CURSOR_EXCHANGE = {
  host: 'api2.cursor.sh',
  path: { exact: '/auth/exchange_user_api_key' },
  method: ['POST'],
} as const satisfies EndpointMatch

/** Codex's model calls: the Responses API, whose response names the served model. */
const OPENAI_MODEL_ENDPOINTS = [
  { host: 'api.openai.com', path: { exact: '/v1/responses' }, method: ['POST'] },
] as const satisfies readonly EndpointMatch[]

/** What Codex sends the key on: its model calls, and its web search tool's own endpoint. */
const OPENAI_ENDPOINTS = [
  ...OPENAI_MODEL_ENDPOINTS,
  { host: 'api.openai.com', path: { exact: '/v1/alpha/search' }, method: ['POST'] },
] as const satisfies readonly EndpointMatch[]

/**
 * The model the Responses API says served a request, from its response (a dated snapshot for some
 * models), and the reasoning effort Codex resolved for it, e.g. `gpt-5.6-luna[effort=medium]`.
 */
const openaiServedModel: ServedModel = ({ host, path, responseModel, responseEffort }) =>
  host === 'api.openai.com' && path === '/v1/responses' && responseModel
    ? `${responseModel}${responseEffort ? `[effort=${responseEffort}]` : ''}`
    : undefined

/**
 * OpenCode on the model's provider (`anthropic/claude-haiku-4-5` is Anthropic's): its key, the
 * requests OpenCode sends it on, its hosts plus Exa's for web search, and the served model from
 * the URL (Gemini's API, Bedrock's) or the response body. Bedrock's hosts are its `AWS_REGION`'s.
 */
export function opencodeForModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelSpecific {
  const resolved = resolveOpenCodeProvider(model, env)
  if ('error' in resolved) throw new InfraError(`opencode(): ${resolved.error}`)
  const { provider } = resolved
  const modelResponses = providerModelResponses(provider)
  return {
    credential: provider.env,
    endpoints: providerEndpoints(provider),
    ...(modelResponses.length ? { modelResponses } : {}),
    modelCalls: providerEndpoints(provider).filter((e) => e.method.includes('POST')),
    servedModel: (request) => providerServedModel(provider, request),
    hosts: [...providerHosts(provider), 'mcp.exa.ai'],
  }
}

/**
 * The variables besides its key that OpenCode's provider takes from the host, as they are:
 * Bedrock's `AWS_REGION` (default `us-east-1`); none for most providers.
 */
export function opencodeVars(model: string, env: NodeJS.ProcessEnv = process.env) {
  const resolved = resolveOpenCodeProvider(model, env)
  if ('error' in resolved) throw new InfraError(`opencode(): ${resolved.error}`)
  return resolved.vars
}

/** reeval's name for a provider's key where it isn't the agent's: Google's, which the judge reads too. */
const HOST_CREDENTIAL: Record<string, string> = { google: 'GOOGLE_GENERATIVE_AI_API_KEY' }

/** A provider's model calls: the POST requests among those its key is sent on. */
const modelCallsOf = (endpoints: readonly EndpointMatch[]) =>
  endpoints.filter((e) => e.method?.includes('POST'))

/** The model a response from `hosts`' model calls names. */
const respondedOn =
  (...hosts: string[]): ServedModel =>
  (request) =>
    hosts.includes(request.host) && request.method === 'POST' ? request.responseModel : undefined

/**
 * pi on the model's provider (`xai/grok-4.5` is xAI's), from the table probed on the pinned pi
 * (harness-pi's pi-provider-table.ts): its key, the requests pi sends it on, their hosts, and the
 * served model from a Gemini API's URL or the response body. Throws naming why reeval can't run a
 * provider pi has, or that pi has none of that name.
 */
export function piForModel(model: string): ModelSpecific {
  const id = providerOf(model)
  const provider = piProvider(id)
  if ('refused' in provider) throw new InfraError(`pi(): ${directProviderRefusal('pi', model)}`)
  const endpoints = provider.endpoints.map(({ host, method, path }) => ({ host, method, path }))
  const hosts = [...new Set(endpoints.map((e) => e.host))]
  const inUrl = provider.endpoints.some((e) => e.api === 'google-generative-ai')
  const modelResponses = provider.endpoints
    .filter((e) => e.api !== 'google-generative-ai')
    .map(({ host, method, path }) => ({ host, method, path }))
  return {
    credential: HOST_CREDENTIAL[id] ?? provider.credentialEnv,
    authAs: provider.credentialEnv,
    endpoints,
    modelCalls: modelCallsOf(endpoints),
    ...(modelResponses.length ? { modelResponses } : {}),
    // The Responses API's on OpenAI's own host also names the effort that served it.
    servedModel: (request) =>
      openaiServedModel(request) ??
      (inUrl && hosts.includes(request.host)
        ? /\/models\/([^/:]+):streamGenerateContent$/.exec(request.path)?.[1]
        : undefined) ??
      respondedOn(...hosts)(request),
    hosts,
  }
}

/** A provider pi runs on its own key; throws naming why reeval can't run one. */
export function keyed(provider: PiProvider | { refused: string }): PiProvider {
  if ('refused' in provider) throw new InfraError(`pi(): ${provider.refused}`)
  return provider
}

/** Anthropic's Messages API, whose response names the model that served it. */
const ANTHROPIC_MESSAGES = [
  { host: 'api.anthropic.com', path: { exact: '/v1/messages' }, method: ['POST'] },
] as const satisfies readonly EndpointMatch[]

/** OpenAI's Chat Completions API, whose response names the model that served it. */
const OPENAI_CHAT = [
  { host: 'api.openai.com', path: { exact: '/v1/chat/completions' }, method: ['POST'] },
] as const satisfies readonly EndpointMatch[]

/** xAI's Chat Completions API, which Goose's OpenAI-compatible `xai` provider calls. */
const XAI_CHAT = [
  { host: 'api.x.ai', path: { exact: '/v1/chat/completions' }, method: ['POST'] },
] as const satisfies readonly EndpointMatch[]

/**
 * Goose on each provider reeval brokers its key for (Goose's `google`, `anthropic`, `openai` and
 * `xai`): its model calls and the model list it fetches.
 */
const GOOSE_DIRECT: Record<string, ModelSpecific> = {
  google: {
    credential: 'GOOGLE_GENERATIVE_AI_API_KEY',
    authAs: 'GOOGLE_API_KEY',
    endpoints: GOOSE_ENDPOINTS,
    servedModel: geminiServedModel,
    hosts: ['generativelanguage.googleapis.com'],
  },
  anthropic: {
    credential: 'ANTHROPIC_API_KEY',
    authAs: 'ANTHROPIC_API_KEY',
    endpoints: [
      ...ANTHROPIC_MESSAGES,
      { host: 'api.anthropic.com', path: { exact: '/v1/models' }, method: ['GET'] },
    ],
    modelResponses: ANTHROPIC_MESSAGES,
    servedModel: respondedOn('api.anthropic.com'),
    hosts: ['api.anthropic.com'],
  },
  // Chat Completions, and the Responses API for OpenAI's reasoning models.
  openai: {
    credential: 'OPENAI_API_KEY',
    authAs: 'OPENAI_API_KEY',
    endpoints: [
      ...OPENAI_CHAT,
      ...OPENAI_MODEL_ENDPOINTS,
      { host: 'api.openai.com', path: { exact: '/v1/models' }, method: ['GET'] },
    ],
    modelResponses: [...OPENAI_CHAT, ...OPENAI_MODEL_ENDPOINTS],
    servedModel: (request) => openaiServedModel(request) ?? respondedOn('api.openai.com')(request),
    hosts: ['api.openai.com'],
  },
  xai: {
    credential: 'XAI_API_KEY',
    authAs: 'XAI_API_KEY',
    endpoints: [...XAI_CHAT, { host: 'api.x.ai', path: { exact: '/v1/models' }, method: ['GET'] }],
    modelResponses: XAI_CHAT,
    servedModel: xaiServedModel,
    hosts: ['api.x.ai'],
  },
}

/** The Goose providers reeval runs on their own keys, for messages. */
export const GOOSE_PROVIDERS = Object.keys(GOOSE_DIRECT)

/** Goose on the model's provider; throws naming the providers reeval brokers a key for. */
export function gooseForModel(model: string): ModelSpecific {
  const direct = GOOSE_DIRECT[providerOf(model)]
  if (!direct) throw new InfraError(`goose(): ${directProviderRefusal('goose', model)}`)
  return { ...direct, modelCalls: modelCallsOf(direct.endpoints) }
}

/** Why pi or Goose can't run `model` on its provider's own key, or undefined when it can. */
export function directProviderRefusal(kind: 'pi' | 'goose', model: string): string | undefined {
  if (kind === 'goose') {
    return GOOSE_DIRECT[providerOf(model)]
      ? undefined
      : `reeval runs Goose on its own key for its ${GOOSE_PROVIDERS.join(', ')} providers, so not ${model}: where Goose's other providers send their keys isn't probed yet. Run it through a gateway`
  }
  const provider = piProvider(providerOf(model))
  return 'refused' in provider ? `${provider.refused}, so not ${model}` : undefined
}

/**
 * fx on the model's provider: OpenAI's Chat Completions API for a bare OpenAI id, and Vercel AI
 * Gateway for a gateway id, which only `vercel()` in the gateway list serves. Each response's
 * first `model` names the model that served it.
 */
export function fxForModel(model: string): ModelSpecific {
  if (!model.includes('/')) {
    const endpoints = [
      { host: 'api.openai.com', path: { exact: '/v1/chat/completions' }, method: ['POST'] },
    ] as const satisfies readonly EndpointMatch[]
    return {
      credential: 'OPENAI_API_KEY',
      endpoints,
      modelResponses: endpoints,
      servedModel: ({ host, responseModel }) =>
        host === 'api.openai.com' ? responseModel : undefined,
      hosts: ['api.openai.com'],
    }
  }
  return {
    credential: VERCEL_KEY,
    endpoints: fxVercelEndpoints(),
    modelResponses: [fxVercelCall()],
    servedModel: servedOn(),
    askedModel: fxAskedModel(),
    hosts: [VERCEL_HOST],
  }
}

/** Each harness's wire facts, by kind; `forModel` gives them for one that depends on its model. */
export const WIRE = {
  cursor: {
    // The SDK trades the key for session tokens at the same endpoint as the CLI, and sends the
    // tokens to api2.cursor.sh only (its agent stream included, over HTTP/1.1 through the proxy).
    endpoints: [CURSOR_EXCHANGE],
    modelCalls: [CURSOR_RUN],
    modelStream: true,
    tokens: {
      endpoint: CURSOR_EXCHANGE,
      fields: ['accessToken', 'refreshToken'],
      hosts: ['cursor.sh', '*.cursor.sh'],
    },
  },
  'claude-code': {
    // What the CLI sends the key on, with non-essential traffic off.
    // Anything else gets a 403 from the gateway and a warning that names the request.
    modelCalls: [{ host: 'api.anthropic.com', path: { exact: '/v1/messages' }, method: ['POST'] }],
    endpoints: [
      { host: 'api.anthropic.com', path: { exact: '/v1/messages' }, method: ['POST'] },
      { host: 'api.anthropic.com', path: { exact: '/v1/messages/count_tokens' }, method: ['POST'] },
      { host: 'api.anthropic.com', path: { exact: '/api/claude_code/settings' }, method: ['GET'] },
      {
        host: 'api.anthropic.com',
        path: { exact: '/api/claude_code/policy_limits' },
        method: ['GET'],
      },
    ],
  },
  antigravity: {
    // Its model calls (the main model, and a lite one for titles) and its web searches, which a
    // lite model answers from Google Search.
    endpoints: ANTIGRAVITY_ENDPOINTS,
    modelCalls: ANTIGRAVITY_ENDPOINTS,
    // The CLI opens both in every session. Neither `enableTelemetry: false` nor any other
    // setting or variable in the binary stops them.
    expectedBlocked: {
      hosts: ['play.googleapis.com', 'antigravity-unleash.goog'],
      why: "Antigravity's telemetry and feature flags, which its CLI sends even with telemetry off",
    },
    // The CLI's `-low`/`-high` ids name an effort; the URL names the model that served it.
    servedModel: geminiServedModel,
  },
  opencode: {
    // The requests the pinned CLI sends each provider's key on (its model, and the same model for
    // titles), probed per provider (harness-opencode's opencode-provider-table.ts).
    forModel: opencodeForModel,
  },
  goose: {
    // The model's provider's: the requests Goose sends its key on, with session naming off.
    forModel: gooseForModel,
    // Goose 1.59.0 refreshes its model catalog from models.dev/api.json in every session, and
    // falls back to the one it bundles when that's refused.
    expectedBlocked: {
      hosts: ['models.dev'],
      why: "Goose's model catalog refresh, which no setting turns off",
    },
  },
  pi: {
    // The model's provider's: the only requests pi sends its key on, since --offline stops its
    // startup network operations.
    forModel: piForModel,
  },
  codex: {
    // On the adapter's provider (HTTP, not WebSockets): the model calls, whose responses name the
    // dated model and the effort that served them, and the web search tool's searches.
    endpoints: OPENAI_ENDPOINTS,
    modelResponses: OPENAI_MODEL_ENDPOINTS,
    // Only with plugins on, which a session with plugins needs; it loads them all the same. In a
    // session without plugins these hosts are a real block.
    expectedBlocked: {
      hosts: ['github.com', 'api.github.com', 'chatgpt.com'],
      why: "Codex's plugin sync, which it runs on every turn once plugins are on",
      withPlugins: true,
    },
    servedModel: openaiServedModel,
  },
  fx: {
    // AI Gateway's, for what names no model; forModel gives the model's provider's.
    ...fxForModel('provider/model'),
    forModel: fxForModel,
  },
  'grok-build': {
    // The requests Grok sends the key on, with its summary, recap and title-refresh calls off.
    endpoints: XAI_ENDPOINTS,
    modelResponses: XAI_MODEL_RESPONSES,
    servedModel: xaiServedModel,
  },
} satisfies Record<AgentKind, Partial<HarnessWire>>
