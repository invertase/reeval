// Vertex AI as a route for a harness's model calls: the project and region the calls go to, the
// model ids each harness names there, and what Vertex can't serve.
import type { AgentKind } from '../catalog/entry.ts'
import type { RouteConfig } from './route.ts'

/** A model publisher on Vertex AI, which may serve its models in a region of its own. */
export type VertexPublisher = 'anthropic' | 'google' | 'xai'

/** The host variable `vertex()` takes its project from when it names none. */
export const VERTEX_PROJECT_ENV = 'GOOGLE_CLOUD_PROJECT'

/** What the attempt's harness runs on: the `vertex()` entry, with its defaults filled in. */
export type VertexSettings = {
  project: string
  location: string
  regions: Partial<Record<VertexPublisher, string>>
}

/** The region a publisher's models are called in: its own, else the entry's location. */
export const vertexRegion = (settings: VertexSettings, publisher: VertexPublisher) =>
  settings.regions[publisher] ?? settings.location

/** Vertex AI's API host for a region: `global` has no prefix. */
export const vertexHost = (region: string) =>
  region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`

/**
 * Vertex's id for a Claude model: an `anthropic/` prefix dropped, and the Anthropic API's dated
 * id (`claude-haiku-4-5-20251001`) written as Vertex's (`claude-haiku-4-5@20251001`), so one
 * model string works on both `vertex()` and `direct()`.
 */
export const vertexClaudeId = (model: string) =>
  model.replace(/^anthropic\//, '').replace(/-(\d{8})$/, '@$1')

/** Vertex's id for an xAI model on its Chat Completions API: `xai/<model>`, unless it names a publisher. */
export const vertexXaiId = (model: string) => (model.includes('/') ? model : `xai/${model}`)

/** OpenCode's id for a Gemini model on Vertex: `google-vertex/<model>`. */
export const openCodeVertexId = (model: string) =>
  `google-vertex/${model.replace(/^(?:google|google-vertex)\//, '')}`

/** fx's id for a Gemini model on Vertex AI's Chat Completions endpoint: `google/<model>`. */
export const fxVertexId = (model: string) => `google/${model.replace(/^google\//, '')}`

const GOOGLE_CLOUD = 'Google Cloud credentials'
const geminiId = (model: string) => model.replace(/^google\//, '')

/** The harnesses reeval runs on Vertex: each one's credential and the model id it names there. */
export const VERTEX_ROUTES: Partial<
  Record<AgentKind, RouteConfig & { modelId: (model: string) => string }>
> = {
  'claude-code': { credential: GOOGLE_CLOUD, modelId: vertexClaudeId },
  antigravity: { credential: GOOGLE_CLOUD, modelId: (model) => model },
  goose: { credential: GOOGLE_CLOUD, modelId: geminiId },
  pi: { credential: GOOGLE_CLOUD, modelId: geminiId },
  opencode: { credential: GOOGLE_CLOUD, modelId: openCodeVertexId },
  'grok-build': { credential: GOOGLE_CLOUD, modelId: vertexXaiId },
  fx: { credential: GOOGLE_CLOUD, modelId: fxVertexId },
}

/**
 * The publisher whose models each harness on Vertex calls, as `reeval doctor` probes them. Grok
 * Build's xAI models have no free token count to probe with, so it isn't here.
 */
const VERTEX_HARNESS_PUBLISHERS: Partial<Record<AgentKind, VertexPublisher>> = {
  'claude-code': 'anthropic',
  antigravity: 'google',
  goose: 'google',
  pi: 'google',
  opencode: 'google',
  fx: 'google',
}

/**
 * The model a harness on Vertex calls, as `publisher/id`, or undefined for one `reeval doctor`
 * doesn't probe there. Antigravity's `-low`/`-medium`/`-high` ids name an effort the CLI sends beside the
 * model, so the id it calls has none.
 */
export function vertexHarnessModel(kind: AgentKind, model: string): string | undefined {
  const publisher = VERTEX_HARNESS_PUBLISHERS[kind]
  if (!publisher) return undefined
  const id = model.replace(/^(?:google|google-vertex|anthropic)\//, '')
  return `${publisher}/${kind === 'antigravity' ? id.replace(/-(?:low|medium|high)$/, '') : id}`
}

/** The model providers (`google` in `google/gemini-3.8-flash`) a harness runs on Vertex AI, and why no other. */
export const VERTEX_AGENT_PROVIDERS: Partial<
  Record<AgentKind, { providers: readonly string[]; only: string }>
> = {
  opencode: {
    providers: ['google', 'google-vertex'],
    only: "OpenCode reaches Vertex AI only on its google-vertex provider, which serves Google's models",
  },
  pi: {
    providers: ['google'],
    only: "pi reaches Vertex AI only on its google-vertex provider, whose catalog has Google's models only",
  },
  goose: {
    providers: ['google'],
    only: "Goose's gcp_vertex_ai provider calls a claude-* model on Anthropic's API on Vertex AI, which reeval doesn't route for Goose yet, so it runs Google's models only there",
  },
}

/** Why Vertex AI can't serve an agent, beyond the ones reeval doesn't route there yet. */
export const VERTEX_REFUSALS: Partial<Record<AgentKind, string>> = {
  cursor: "Cursor's agent only calls Cursor's own API",
  codex: "Codex only calls OpenAI's Responses API, which Vertex AI doesn't serve",
}
