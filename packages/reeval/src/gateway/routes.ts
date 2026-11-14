// The gateways that route a harness's model calls somewhere other than its provider's own API:
// each one's @reeval/agents route (the harnesses it serves, what each authenticates with and the
// model id it names, and why it can't serve the rest) with what the egress gateway needs for each.
import type { Route, RouteConfig, RouteName } from '@reeval/agents'
import type { ROUTING_GATEWAY_NAMES } from '../contract/gateway.ts'
import type { Agent, AgentKind, ModelSpecific } from '../harness/agents.ts'
import { OPENROUTER_GATEWAY } from './openrouter.ts'
import { VERCEL_GATEWAY } from './vercel.ts'

/**
 * What a harness on a gateway needs besides its usual catalog entry: the variable the adapter
 * takes the key as, any it takes beside it, the model id the gateway serves for the harness's own,
 * and the hosts the agent tries there and is refused.
 */
export type GatewayRoute = ModelSpecific &
  Pick<Agent, 'authEnv' | 'modelId' | 'expectedBlocked'> & { authAs: string }

/** What the egress gateway adds to a harness's route: its {@link GatewayRoute} less the route's own. */
export type RouteWire = Omit<GatewayRoute, keyof RouteConfig>

/** A gateway that routes harnesses: its name for messages, its routes and its refusals. */
export type RoutingGateway = Omit<Route, 'routes'> & {
  routes: Partial<Record<AgentKind, (env: NodeJS.ProcessEnv) => GatewayRoute>>
}

/** Vertex AI takes a minted token, not a brokered key, so it has a catalog of its own. */
export type RoutingGatewayName = (typeof ROUTING_GATEWAY_NAMES)[number]

/** Every gateway that brokers a key, by name. */
export const ROUTING_GATEWAYS: Readonly<Record<RoutingGatewayName, RoutingGateway>> = {
  vercel: VERCEL_GATEWAY,
  openrouter: OPENROUTER_GATEWAY,
} satisfies Record<RouteName, RoutingGateway>

/** Whether a harness's `gateway` names one of {@link ROUTING_GATEWAYS}. */
export const isRoutingGateway = (name: string | undefined): name is RoutingGatewayName =>
  name !== undefined && Object.hasOwn(ROUTING_GATEWAYS, name)

/**
 * What a harness's adapter takes on the routing gateway the harness resolved to, from one entry
 * per gateway, so a new gateway names it for every adapter; undefined on direct and Vertex AI.
 */
export const onRoutingGateway = <T>(
  harness: { gateway?: string },
  each: Readonly<Record<RoutingGatewayName, T>>,
): T | undefined => (isRoutingGateway(harness.gateway) ? each[harness.gateway] : undefined)
