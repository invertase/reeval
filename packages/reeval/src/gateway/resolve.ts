// Which gateway in the config's `gateway` list each harness's model calls go through: the first
// entry that can serve it, or the one it pins. Pure, so the plan refuses before anything starts.
import { UsageError } from '../errors.ts'
import { AGENTS, isAgentKind } from '../harness/agents.ts'
import { harnessId } from '../options.ts'
import type {
  GatewayDescriptor,
  GatewayName,
  HarnessDescriptor,
  ResolvedGateway,
} from '../types.ts'

/** The config's list when it sets none: each provider's own key, as reeval has always run. */
export const DEFAULT_GATEWAYS: GatewayDescriptor[] = [{ kind: 'direct' }]

/** The helper each gateway is made by, as messages name it. */
export const GATEWAY_HELPERS: Record<GatewayName, string> = {
  direct: 'direct()',
  fake: 'fakeGateway()',
}

const agentName = (h: HarnessDescriptor) =>
  isAgentKind(h.kind) ? AGENTS[h.kind].name : 'the fake harness'

/** Why `gateway` can't serve `harness`, or undefined when it can. */
export function cantServe(
  gateway: GatewayDescriptor,
  harness: HarnessDescriptor,
): string | undefined {
  switch (gateway.kind) {
    case 'direct':
      return undefined
    case 'fake': {
      const serves = gateway.serves ?? ['fake']
      return serves.includes(harness.kind)
        ? undefined
        : `fakeGateway() serves ${serves.length ? serves.join(', ') : 'no harness'}, not ${agentName(harness)}`
    }
  }
}

/**
 * The gateway `harness` resolves to in `gateways`: its pin, or the first entry that can serve it,
 * with each entry before it and why it couldn't. Throws a UsageError naming every entry tried.
 */
export function resolveGateway(
  gateways: GatewayDescriptor[],
  harness: HarnessDescriptor,
  where: string,
): ResolvedGateway {
  const on = `${where} on ${harnessId(harness)}`
  const listed = gateways.map((g) => g.kind).join(', ')
  if (harness.gateway !== undefined) {
    const pinned = gateways.find((g) => g.kind === harness.gateway)
    if (!pinned) {
      throw new UsageError(
        `${on}: it pins gateway '${harness.gateway}', which isn't in the gateway list (${listed}). Add ${GATEWAY_HELPERS[harness.gateway]} to gateway, or pin one that's there.`,
      )
    }
    const why = cantServe(pinned, harness)
    if (why) {
      throw new UsageError(
        `${on}: it pins gateway '${harness.gateway}', which can't serve it (${why}). A pin never falls back; pin another gateway, or remove the pin to take the first in the list that can.`,
      )
    }
    return { name: pinned.kind, skipped: [] }
  }
  const skipped: ResolvedGateway['skipped'] = []
  for (const gateway of gateways) {
    const why = cantServe(gateway, harness)
    if (!why) return { name: gateway.kind, skipped }
    skipped.push({ gateway: gateway.kind, why })
  }
  throw new UsageError(
    `${on}: no gateway in the list can serve it (${skipped.map((s) => `${s.gateway}: ${s.why}`).join('; ')}). Add direct() to the end of gateway to use ${agentName(harness)}'s own key.`,
  )
}

/** `gateway: fake → direct (fake: fakeGateway() serves fake, not Cursor)`, for the plan's hints. */
export const fallbackHint = (harness: string, resolved: ResolvedGateway): string =>
  `gateway: ${harness} → ${resolved.name} (${resolved.skipped.map((s) => `${s.gateway} can't serve it: ${s.why}`).join('; ')})`
