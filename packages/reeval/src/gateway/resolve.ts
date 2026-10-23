// Which gateway in the config's `gateway` list each harness's model calls go through: the first
// entry that can serve it, or the one it pins. Pure, so the plan refuses before anything starts.
import { resolveOpenCodeProvider } from '@reeval/harness-opencode/providers'
import { UsageError } from '../errors.ts'
import { AGENTS, isAgentKind } from '../harness/agents.ts'
import { harnessEffort } from '../harness/effort.ts'
import { harnessId } from '../options.ts'
import type {
  GatewayDescriptor,
  GatewayName,
  HarnessDescriptor,
  ResolvedGateway,
} from '../types.ts'
import { ROUTING_GATEWAYS, type RoutingGatewayName } from './routes.ts'
import { VERTEX_REFUSALS } from './vertex.ts'

/** The config's list when it sets none: each provider's own key, as reeval has always run. */
export const DEFAULT_GATEWAYS: GatewayDescriptor[] = [{ kind: 'direct' }]

/** What reeval knows of a gateway: why it can't serve a harness, or undefined when it can. */
export type GatewayEntry = {
  cantServe: (harness: HarnessDescriptor) => string | undefined
}

/** Every gateway reeval can route through, by name. */
export const GATEWAYS: Readonly<Record<GatewayName, GatewayEntry>> = {
  direct: {
    cantServe: (h) => {
      if (h.kind === 'fx' && h.model.includes('/')) {
        return `fx runs a gateway id such as ${JSON.stringify(h.model)} only through Vercel AI Gateway`
      }
      if (h.kind === 'opencode') {
        const resolved = resolveOpenCodeProvider(h.model, process.env)
        if ('error' in resolved) return resolved.error
      }
      return undefined
    },
  },
  vercel: routingEntry('vercel'),
  openrouter: routingEntry('openrouter'),
  vertex: {
    cantServe: (h) =>
      h.kind === 'fake'
        ? undefined
        : (VERTEX_REFUSALS[h.kind] ?? `reeval doesn't run ${agentName(h)} on Vertex AI yet`),
  },
}

/** A routing gateway's entry: its route table decides whom it serves, and with what effort. */
function routingEntry(name: RoutingGatewayName): GatewayEntry {
  const gateway = ROUTING_GATEWAYS[name]
  return {
    // A fake agent calls no model, so any gateway serves it.
    cantServe: (h) => {
      if (h.kind !== 'fake' && !gateway.routes[h.kind]) {
        return (
          gateway.refusals[h.kind] ?? `reeval doesn't run ${agentName(h)} on ${gateway.name} yet`
        )
      }
      const effort = harnessEffort(h)
      if (effort !== undefined && h.kind !== 'fake' && gateway.unprovenEffort.includes(h.kind)) {
        return `reeval doesn't send ${agentName(h)}'s effort (${JSON.stringify(effort)}) through ${gateway.name} yet: nothing checks the model gets it as its own setting, so drop effort or run ${agentName(h)} on another gateway`
      }
      return undefined
    },
  }
}

/** The `reeval/gateway` helper that makes the gateway `name`, as messages name it. */
export const gatewayHelper = (name: string) => `${name}()`

/** The agent's name, for messages. */
export const agentName = (h: HarnessDescriptor) =>
  isAgentKind(h.kind) ? AGENTS[h.kind].name : 'the fake harness'

/**
 * The gateway `harness` resolves to in `gateways`: its pin, or the first entry that can serve it,
 * with each entry before it and why it couldn't. Throws a UsageError naming every entry tried.
 */
export function resolveGateway(
  gateways: readonly { kind: string }[],
  harness: HarnessDescriptor,
  where: string,
  catalog: Readonly<Record<string, GatewayEntry>> = GATEWAYS,
): ResolvedGateway {
  const on = `${where} on ${harnessId(harness)}`
  const listed = gateways.map((g) => g.kind).join(', ')
  const why = (name: string) => catalog[name]?.cantServe(harness)
  const pin: string | undefined = harness.gateway
  if (pin !== undefined) {
    if (!gateways.some((g) => g.kind === pin)) {
      throw new UsageError(
        `${on}: it pins gateway '${pin}', which isn't in the gateway list (${listed}). Add ${gatewayHelper(pin)} to gateway, or pin one that's there.`,
      )
    }
    const refused = why(pin)
    if (refused) {
      throw new UsageError(
        `${on}: it pins gateway '${pin}', which can't serve it (${refused}). A pin never falls back; pin another gateway, or remove the pin to take the first in the list that can.`,
      )
    }
    return { name: pin as GatewayName, skipped: [] }
  }
  const skipped: ResolvedGateway['skipped'] = []
  for (const { kind } of gateways) {
    const refused = why(kind)
    if (!refused) return { name: kind as GatewayName, skipped }
    skipped.push({ gateway: kind as GatewayName, why: refused })
  }
  throw new UsageError(
    `${on}: no gateway in the list can serve it (${skipped.map((s) => `${s.gateway}: ${s.why}`).join('; ')}). ${addHint(gateways, harness, catalog)}`,
  )
}

/** What to add to the list so it serves `harness`: `direct()` when it can, else the first that can. */
function addHint(
  gateways: readonly { kind: string }[],
  harness: HarnessDescriptor,
  catalog: Readonly<Record<string, GatewayEntry>>,
): string {
  const unlisted = Object.keys(catalog).filter((name) => !gateways.some((g) => g.kind === name))
  const serves = unlisted.filter((name) => !catalog[name]?.cantServe(harness))
  if (serves.includes('direct')) {
    return `Add direct() to the end of gateway to use ${agentName(harness)}'s own key.`
  }
  const [first] = serves
  return first ? `Add ${gatewayHelper(first)} to gateway.` : `No gateway reeval knows can serve it.`
}

/**
 * `harness` carrying the gateway it resolves to in `gateways`, as the plan gives it to the
 * worker; as written on `direct`, or when nothing serves it (the plan says why).
 */
export function routedHarness(
  harness: HarnessDescriptor,
  gateways: readonly { kind: string }[],
): HarnessDescriptor {
  try {
    const { name } = resolveGateway(gateways, harness, '')
    return name === 'direct' ? harness : { ...harness, gateway: name }
  } catch {
    return harness
  }
}

/** `gateway: claude-code:… → direct (vercel can't serve it: …)`, for the plan's hints. */
export const fallbackHint = (harness: string, resolved: ResolvedGateway): string =>
  `gateway: ${harness} → ${resolved.name} (${resolved.skipped.map((s) => `${s.gateway} can't serve it: ${s.why}`).join('; ')})`
