// Vertex AI as a route for a harness's model calls: the project and region from the vertex()
// entry, a host-minted Google Cloud access token the egress gateway adds to the agent's model
// calls, and what Vertex can't serve.
import type { EndpointMatch, RequestTransformation } from '@reeval/sandbox-docker'
import { UsageError } from '../errors.ts'
import type { AgentKind, ModelSpecific } from '../harness/agents.ts'
import type { VertexGatewayDescriptor, VertexPublisher } from '../types.ts'
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
  routeEnv: Record<string, string>
  token: BrokeredToken
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A publisher's model calls in the project and region: `…/publishers/<publisher>/models/<id>:<method>`. */
function publisherEndpoint(
  settings: VertexSettings,
  publisher: VertexPublisher,
  methods: readonly string[],
): EndpointMatch {
  const region = vertexRegion(settings, publisher)
  return {
    host: vertexHost(region),
    path: {
      regex: `^/v1/projects/${escapeRegex(settings.project)}/locations/${escapeRegex(region)}/publishers/${publisher}/models/[^/:?]+:(?:${methods.join('|')})(?:\\?.*)?$`,
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
    modelId: (model) => model.replace(/^anthropic\//, ''),
    routeEnv: {
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
      ANTHROPIC_VERTEX_PROJECT_ID: settings.project,
      CLOUD_ML_REGION: region,
    },
    token: { source, transformations: bearerOn(endpoints) },
  }
}

/** The harnesses reeval runs on Vertex, and what each needs there. */
export const VERTEX_ROUTES: Partial<
  Record<AgentKind, (settings: VertexSettings, source?: TokenSource) => VertexRoute>
> = {
  'claude-code': claudeCode,
}

/** Why Vertex AI can't serve an agent, beyond the ones reeval doesn't route there yet. */
export const VERTEX_REFUSALS: Partial<Record<AgentKind, string>> = {
  cursor: "Cursor's agent only calls Cursor's own API",
  codex: "Codex only calls OpenAI's Responses API, which Vertex AI doesn't serve",
}
