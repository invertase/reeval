// Vertex AI as a route for a harness's model calls: the project and region from the vertex()
// entry, a host-minted Google Cloud access token the egress gateway adds to the agent's model
// calls, and what Vertex can't serve.
import { generateKeyPairSync } from 'node:crypto'
import type { EndpointMatch, LocalResponse, RequestTransformation } from '@reeval/sandbox-docker'
import { UsageError } from '../errors.ts'
import type { AgentKind, ModelSpecific } from '../harness/agents.ts'
import type { GatewayDescriptor, VertexGatewayDescriptor, VertexPublisher } from '../types.ts'
import { type BrokeredToken, cachedTokenSource, type TokenSource } from './token.ts'

/** The host variable `vertex()` takes its project from when it names none. */
export const VERTEX_PROJECT_ENV = 'GOOGLE_CLOUD_PROJECT'

/** What the attempt's harness runs on: the `vertex()` entry, with its defaults filled in. */
export type VertexSettings = {
  project: string
  location: string
  regions: Partial<Record<VertexPublisher, string>>
}

/** The entry's settings; a UsageError when neither it nor `GOOGLE_CLOUD_PROJECT` names a project. */
export function vertexSettings(
  entry: Omit<VertexGatewayDescriptor, 'kind'> = {},
  env: NodeJS.ProcessEnv = process.env,
): VertexSettings {
  const project = entry.project ?? env[VERTEX_PROJECT_ENV]
  if (!project) {
    throw new UsageError(
      `vertex() has no project: set vertex({ project: '<id>' }) or ${VERTEX_PROJECT_ENV}`,
    )
  }
  return { project, location: entry.location ?? 'global', regions: entry.regions ?? {} }
}

/** The settings of the `vertex()` entry in a gateway list; a UsageError when it names no project. */
export function vertexSettingsIn(
  gateways: readonly GatewayDescriptor[],
  env: NodeJS.ProcessEnv = process.env,
): VertexSettings {
  const entry = gateways.find((g) => g.kind === 'vertex')
  return vertexSettings(entry?.kind === 'vertex' ? entry : {}, env)
}

/** The region a publisher's models are called in: its own, else the entry's location. */
export const vertexRegion = (settings: VertexSettings, publisher: VertexPublisher) =>
  settings.regions[publisher] ?? settings.location

/** Vertex AI's API host for a region: `global` has no prefix. */
export const vertexHost = (region: string) =>
  region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`

const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform'
/** How long a token is taken to last when its client doesn't say. */
const UNKNOWN_LIFETIME_MS = 10 * 60_000

/** Access tokens from Application Default Credentials on the host. */
export function adcTokenSource(now = Date.now): TokenSource {
  let client: Promise<{ getAccessToken(): Promise<{ token?: string | null }> }> | undefined
  return async () => {
    client ??= import('google-auth-library').then(({ GoogleAuth }) =>
      new GoogleAuth({ scopes: [CLOUD_PLATFORM] }).getClient(),
    )
    const auth = await client
    const { token } = await auth.getAccessToken()
    if (!token) throw new Error('Application Default Credentials gave no access token')
    const expiry = (auth as { credentials?: { expiry_date?: number | null } }).credentials
      ?.expiry_date
    return { token, expiresAt: typeof expiry === 'number' ? expiry : now() + UNKNOWN_LIFETIME_MS }
  }
}

let shared: TokenSource | undefined
/** The process's one ADC token source, shared by every attempt in it. */
export const vertexTokens = (): TokenSource => {
  shared ??= cachedTokenSource(adcTokenSource())
  return shared
}

/** What a harness on Vertex needs besides its usual catalog entry. */
export type VertexRoute = ModelSpecific & {
  /** The model id Vertex serves for the harness's own id. */
  modelId: (model: string) => string
  /** Variables the adapter sets for the agent, pointing it at the project and region. */
  routeEnv?: Record<string, string>
  token: BrokeredToken
  /** Application Default Credentials the agent's CLI reads in the sandbox, for a CLI that needs some. */
  adc?: SandboxAdc
  /** Requests the egress gateway answers itself, never reaching Google. */
  localResponses?: readonly LocalResponse[]
}

/**
 * A service-account file in the sandbox with a key made up for it, which Google's client
 * libraries trade for a token at `oauth2.googleapis.com/token`. The egress gateway answers that
 * with a placeholder, and adds the real token to the model calls.
 */
export type SandboxAdc = {
  project: string
  location: string
  /** Where it goes, beside the workspace: `../<file>` from it. */
  file: string
  content: string
}

/**
 * Vertex's id for a Claude model: an `anthropic/` prefix dropped, and the Anthropic API's dated
 * id (`claude-haiku-4-5-20251001`) written as Vertex's (`claude-haiku-4-5@20251001`), so one
 * model string works on both `vertex()` and `direct()`.
 */
export const vertexClaudeId = (model: string) =>
  model.replace(/^anthropic\//, '').replace(/-(\d{8})$/, '@$1')

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A publisher's model calls in the project and region: `…/publishers/<publisher>/models/<id>:<method>`. */
function publisherEndpoint(
  settings: VertexSettings,
  publisher: VertexPublisher,
  methods: readonly string[],
  versions: readonly string[] = ['v1'],
): EndpointMatch {
  const region = vertexRegion(settings, publisher)
  return {
    host: vertexHost(region),
    path: {
      regex: `^/(?:${versions.join('|')})/projects/${escapeRegex(settings.project)}/locations/${escapeRegex(region)}/publishers/${publisher}/models/[^/:?]+:(?:${methods.join('|')})(?:\\?.*)?$`,
    },
    method: ['POST'],
  }
}

/** The token as a bearer on exactly these requests: the agent sends none of its own. */
const bearerOn =
  (endpoints: readonly EndpointMatch[]) =>
  (token: string): RequestTransformation[] =>
    endpoints.map((match) => ({
      match,
      transform: { headers: { authorization: `Bearer ${token}` } },
    }))

/**
 * Claude Code with `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_SKIP_VERTEX_AUTH`: the CLI then calls
 * `…/publishers/anthropic/models/<model>:streamRawPredict` with no credential, and nothing else,
 * so the gateway adds the bearer there.
 */
function claudeCode(settings: VertexSettings, source = vertexTokens()): VertexRoute {
  const region = vertexRegion(settings, 'anthropic')
  const endpoints = [publisherEndpoint(settings, 'anthropic', ['streamRawPredict', 'rawPredict'])]
  return {
    credential: 'Google Cloud credentials',
    endpoints,
    hosts: [vertexHost(region)],
    servedModel: ({ host, path }) => {
      if (host !== vertexHost(region)) return undefined
      const model = /\/publishers\/anthropic\/models\/([^/:]+):/.exec(path)?.[1]
      return model && model !== 'count-tokens' ? model : undefined
    },
    modelId: vertexClaudeId,
    routeEnv: {
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
      ANTHROPIC_VERTEX_PROJECT_ID: settings.project,
      CLOUD_ML_REGION: region,
    },
    token: { source, transformations: bearerOn(endpoints) },
  }
}

/** Where Google's client libraries trade a service account's signed assertion for a token. */
const TOKEN_ENDPOINT: EndpointMatch = {
  host: 'oauth2.googleapis.com',
  path: { exact: '/token' },
  method: ['POST'],
}

/** The access token the sandbox's CLI gets, which the gateway replaces on the model calls. */
export const SANDBOX_ACCESS_TOKEN = 'reeval-vertex-placeholder'

let sandboxKey: string | undefined
/** The private key of every sandbox's service account: made up, once a process, and never valid. */
const sandboxPrivateKey = () => {
  sandboxKey ??= generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
  return sandboxKey
}

const sandboxAccount = (project: string) => `reeval-sandbox@${project}.iam.gserviceaccount.com`

/** A service account in the project that only the egress gateway's token endpoint accepts. */
function sandboxAdc(settings: VertexSettings): SandboxAdc {
  const content = JSON.stringify({
    type: 'service_account',
    project_id: settings.project,
    private_key_id: 'reeval-sandbox',
    private_key: sandboxPrivateKey(),
    client_email: sandboxAccount(settings.project),
    client_id: '0',
    token_uri: `https://${TOKEN_ENDPOINT.host}/token`,
  })
  return {
    project: settings.project,
    location: vertexRegion(settings, 'google'),
    file: 'google-adc.json',
    content,
  }
}

const json = (body: unknown) => JSON.stringify(body)

/** The token endpoint's answer, a placeholder token for an hour. */
const tokenResponse: LocalResponse = {
  match: TOKEN_ENDPOINT,
  status: 200,
  body: json({ access_token: SANDBOX_ACCESS_TOKEN, expires_in: 3599, token_type: 'Bearer' }),
}

/**
 * A Gemini CLI on Vertex through Application Default Credentials: the service account in
 * `adc`, its token from the gateway, and the gateway's bearer on Google's model calls in the
 * project (`v1` or `v1beta1`, streamed or not).
 */
function gemini(
  extraHosts: readonly string[] = [],
  extraResponses: (settings: VertexSettings) => readonly LocalResponse[] = () => [],
  modelId: (model: string) => string = (model) => model.replace(/^google\//, ''),
) {
  return (settings: VertexSettings, source = vertexTokens()): VertexRoute => {
    const region = vertexRegion(settings, 'google')
    const endpoints = [
      publisherEndpoint(
        settings,
        'google',
        ['streamGenerateContent', 'generateContent'],
        ['v1', 'v1beta1'],
      ),
    ]
    return {
      credential: 'Google Cloud credentials',
      endpoints,
      hosts: [vertexHost(region), TOKEN_ENDPOINT.host, ...extraHosts],
      servedModel: ({ host, path }) =>
        host === vertexHost(region)
          ? /\/publishers\/google\/models\/([^/:]+):/.exec(path)?.[1]
          : undefined,
      modelId,
      token: { source, transformations: bearerOn(endpoints) },
      adc: sandboxAdc(settings),
      localResponses: [tokenResponse, ...extraResponses(settings)],
    }
  }
}

/** The account Antigravity looks up with its token as a session starts, answered as the sandbox's. */
const antigravityUserinfo = (settings: VertexSettings): LocalResponse[] => [
  {
    match: { host: 'www.googleapis.com', path: { exact: '/oauth2/v2/userinfo' }, method: ['GET'] },
    status: 200,
    body: json({ id: '0', email: sandboxAccount(settings.project), verified_email: true }),
  },
]

/** OpenCode's id for a Gemini model on Vertex: `google-vertex/<model>`. */
export const openCodeVertexId = (model: string) =>
  `google-vertex/${model.replace(/^(?:google|google-vertex)\//, '')}`

/** The harnesses reeval runs on Vertex, and what each needs there. */
export const VERTEX_ROUTES: Partial<
  Record<AgentKind, (settings: VertexSettings, source?: TokenSource) => VertexRoute>
> = {
  'claude-code': claudeCode,
  // AGY_ADC_AUTH: the CLI calls `/v1/…:streamGenerateContent`, titles on gemini-3.1-flash-lite.
  antigravity: gemini(['www.googleapis.com'], antigravityUserinfo, (model) => model),
  // gcp_vertex_ai: `/v1beta1/…:streamGenerateContent`.
  goose: gemini(),
  // google-vertex: `/v1/…:streamGenerateContent`.
  pi: gemini(),
  // google-vertex: `/v1beta1/…:streamGenerateContent`, the session's title on the same model, and
  // web search on Exa's keyless MCP server.
  opencode: gemini(['mcp.exa.ai'], () => [], openCodeVertexId),
}

/** Why Vertex AI can't serve an agent, beyond the ones reeval doesn't route there yet. */
export const VERTEX_REFUSALS: Partial<Record<AgentKind, string>> = {
  cursor: "Cursor's agent only calls Cursor's own API",
  codex: "Codex only calls OpenAI's Responses API, which Vertex AI doesn't serve",
}

/** The model prefixes reeval calls on Vertex AI itself (the judge, analysis, captures, questions). */
export const VERTEX_MODEL_PROVIDERS = ['google', 'anthropic'] as const

/** Why reeval can't call `model` on Vertex AI, or undefined when it can. */
export const vertexModelRefusal = (model: string) =>
  (VERTEX_MODEL_PROVIDERS as readonly string[]).includes(model.slice(0, model.indexOf('/')))
    ? undefined
    : `reeval calls only ${VERTEX_MODEL_PROVIDERS.map((p) => `${p}/*`).join(' and ')} models on Vertex AI`

/**
 * A `google/*` or `anthropic/*` model on Vertex AI in the entry's project and the publisher's
 * region, authenticated with the process's token source, so ADC is read in one place.
 */
export async function vertexLanguageModel(
  model: string,
  settings: VertexSettings,
  source: TokenSource = vertexTokens(),
) {
  const refused = vertexModelRefusal(model)
  if (refused) throw new Error(`${refused} (got "${model}")`)
  const provider = model.slice(0, model.indexOf('/'))
  const id = model.slice(provider.length + 1)
  const googleAuthOptions = {
    authClient: { getAccessToken: async () => ({ token: (await source()).token }) },
  } as unknown as NonNullable<
    Parameters<typeof import('@ai-sdk/google-vertex').createVertex>[0]
  >['googleAuthOptions']
  if (provider === 'anthropic') {
    const { createVertexAnthropic } = await import('@ai-sdk/google-vertex/anthropic')
    const location = vertexRegion(settings, 'anthropic')
    return createVertexAnthropic({ project: settings.project, location, googleAuthOptions })(
      vertexClaudeId(id),
    )
  }
  const { createVertex } = await import('@ai-sdk/google-vertex')
  const location = vertexRegion(settings, 'google')
  return createVertex({ project: settings.project, location, googleAuthOptions })(id)
}

/** As `vertexLanguageModel`, as a decision model for the judge. */
export async function vertexDecisionModel(
  model: string,
  settings: VertexSettings,
  source: TokenSource = vertexTokens(),
) {
  const { Experimental_DecisionLanguageModel } = await import(
    '@ai-sdk/provider-utils/experimental-decision'
  )
  return new Experimental_DecisionLanguageModel({
    model: await vertexLanguageModel(model, settings, source),
    provider: 'google-vertex.decision',
  })
}
