// Adds the egress gateway's half of each harness's route to its @reeval/agents configuration.
import type { Route, RouteConfig } from '@reeval/agents'
import type { AgentKind } from '../harness/agents.ts'
import type { RouteWire, RoutingGateway } from './routes.ts'

/** `route` with each harness's wire half added to its configuration. */
export function withWire(
  route: Route,
  wire: Partial<Record<AgentKind, (env: NodeJS.ProcessEnv) => RouteWire>>,
): RoutingGateway {
  const extra = Object.keys(wire).filter((kind) => !Object.hasOwn(route.routes, kind))
  if (extra.length)
    throw new Error(
      `${route.name} has wire entries for ${extra.join(', ')}, which it doesn't serve`,
    )
  const routes: RoutingGateway['routes'] = {}
  for (const [kind, config] of Object.entries(route.routes) as [
    AgentKind,
    (env: NodeJS.ProcessEnv) => RouteConfig,
  ][]) {
    const half = wire[kind]
    if (!half) throw new Error(`${route.name} has no wire entry for ${kind}`)
    routes[kind] = (env) => ({ ...config(env), ...half(env) })
  }
  return { ...route, routes }
}
