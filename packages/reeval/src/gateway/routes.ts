// The gateways that route a harness's model calls somewhere other than its provider's own API:
// for each, the harnesses it serves and what each needs there, and why it can't serve the rest.
import type { Agent, AgentKind, ModelSpecific } from '../harness/agents.ts'
import type { GatewayName } from '../types.ts'
import { OPENROUTER_GATEWAY } from './openrouter.ts'
import { VERCEL_GATEWAY } from './vercel.ts'

/**
 * What a harness on a gateway needs besides its usual catalog entry: the variable the adapter
 * takes the key as, any it takes beside it, the model id the gateway serves for the harness's own,
 * and the hosts the agent tries there and is refused.
 */
export type GatewayRoute = ModelSpecific &
  Pick<Agent, 'authEnv' | 'modelId' | 'expectedBlocked'> & { authAs: string }

/** A gateway that routes harnesses: its name for messages, its routes and its refusals. */
export type RoutingGateway = {
  /** For messages: `Vercel AI Gateway`. */
  name: string
  routes: Partial<Record<AgentKind, (env: NodeJS.ProcessEnv) => GatewayRoute>>
  /** Why it can't serve an agent it has no route for, for the plan's messages. */
  refusals: Partial<Record<AgentKind, string>>
  /**
   * The harnesses whose `effort` reaches the model there by a path no real run has checked: the
   * plan refuses `effort` with them on this gateway.
   */
  unprovenEffort: readonly AgentKind[]
}

/** Vertex AI takes a minted token, not a brokered key, so it has a catalog of its own. */
export type RoutingGatewayName = Exclude<GatewayName, 'direct' | 'vertex'>

/** Every gateway that brokers a key, by name. */
export const ROUTING_GATEWAYS: Readonly<Record<RoutingGatewayName, RoutingGateway>> = {
  vercel: VERCEL_GATEWAY,
  openrouter: OPENROUTER_GATEWAY,
}

/** Whether a harness's `gateway` names one of {@link ROUTING_GATEWAYS}. */
export const isRoutingGateway = (name: string | undefined): name is RoutingGatewayName =>
  name !== undefined && Object.hasOwn(ROUTING_GATEWAYS, name)
