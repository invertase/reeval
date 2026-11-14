// A route that sends a harness's model calls somewhere other than its provider's own API: for
// each harness it serves, the credential and model id it takes there, and why it can't serve the
// rest.
import type { AgentKind } from '../catalog/entry.ts'
import type { RouteApi } from './api.ts'

/** What a harness on a route authenticates with, and the model id the route serves for its own. */
export type RouteConfig = {
  /** The host variable the credential comes from. */
  credential: string
  /** The model id the route serves for the harness's own, when not the catalog entry's. */
  modelId?: (model: string) => string
}

/** A route that serves harnesses on one key: its name for messages, its harnesses and its refusals. */
export type Route = {
  /** For messages: `Vercel AI Gateway`. */
  name: string
  /** Where its APIs are, from the host environment. */
  api: (env: NodeJS.ProcessEnv) => RouteApi
  routes: Partial<Record<AgentKind, (env: NodeJS.ProcessEnv) => RouteConfig>>
  /** Why it can't serve an agent it has no route for, for the plan's messages. */
  refusals: Partial<Record<AgentKind, string>>
  /** Why it can't serve an agent it has a route for in this host environment, or undefined. */
  refusedAt?: Partial<Record<AgentKind, (env: NodeJS.ProcessEnv) => string | undefined>>
  /**
   * The harnesses whose `effort` reaches the model there by a path no real run has checked, each
   * with the models (as the eval names them) that holds for: the plan refuses `effort` with them
   * on this route.
   */
  unprovenEffort: Partial<Record<AgentKind, (model: string) => boolean>>
}
