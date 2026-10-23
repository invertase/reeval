// Which gateway in the config's `gateway` list a model reeval calls itself goes through (the
// judge's, analysis's, a capture's): its pin, or the first entry that can serve the model.
import { GATEWAY_NAMES } from '../contract/gateway.ts'
import { UsageError } from '../errors.ts'
import { DIRECT_PROVIDERS } from '../judge/index.ts'
import type {
  GatewayDescriptor,
  GatewayName,
  JudgeModel,
  ResolvedConfig,
  ResolvedProfile,
} from '../types.ts'
import { gatewayHelper } from './resolve.ts'

const providerOf = (model: string) => model.slice(0, model.indexOf('/'))

/** Why each gateway can't serve a model by name, or undefined when it can. */
const MODEL_GATEWAYS: Readonly<Record<GatewayName, (model: string) => string | undefined>> = {
  direct: (model) =>
    DIRECT_PROVIDERS[providerOf(model)]
      ? undefined
      : `reeval calls only ${Object.keys(DIRECT_PROVIDERS)
          .map((p) => `${p}/*`)
          .join(', ')} models on their own keys`,
  vercel: () => undefined,
}

/** The run's gateway list, and whether the config or the profile set it. */
export type GatewayScope = { gateways: readonly GatewayDescriptor[]; set: boolean }

export const gatewayScope = (
  config: Pick<ResolvedConfig, 'gateway' | 'gatewaySet'>,
  profile?: Pick<ResolvedProfile, 'gateway'> | null,
): GatewayScope => ({
  gateways: profile?.gateway ?? config.gateway,
  set: config.gatewaySet || profile?.gateway !== undefined,
})

/**
 * The gateway `model` goes through, or undefined when neither the list nor a pin is set: then it
 * takes its provider's own key, else Vercel's, whichever is set. A model object or a fake calls
 * through itself. Throws a UsageError naming each gateway tried.
 */
export function resolveModelGateway(
  model: JudgeModel | undefined,
  pin: GatewayName | GatewayDescriptor | undefined,
  scope: GatewayScope,
  what: string,
): GatewayName | undefined {
  if (typeof model !== 'string') return undefined
  if (!scope.set && pin === undefined) return undefined
  const on = `${what} "${model}"`
  const listed = scope.gateways.map((g) => g.kind)
  const name = typeof pin === 'object' ? pin.kind : pin
  if (name !== undefined) {
    if (!listed.includes(name)) {
      throw new UsageError(
        `${on} pins gateway '${name}', which isn't in the gateway list (${listed.join(', ')}). Add ${gatewayHelper(name)} to gateway, or pin one that's there.`,
      )
    }
    const refused = MODEL_GATEWAYS[name](model)
    if (refused) {
      throw new UsageError(
        `${on} pins gateway '${name}', which can't serve it (${refused}). A pin never falls back; pin another gateway, or remove the pin to take the first in the list that can.`,
      )
    }
    return name
  }
  const skipped: string[] = []
  for (const kind of listed) {
    const refused = MODEL_GATEWAYS[kind](model)
    if (!refused) return kind
    skipped.push(`${kind}: ${refused}`)
  }
  const other = GATEWAY_NAMES.find((n) => !listed.includes(n) && !MODEL_GATEWAYS[n](model))
  throw new UsageError(
    `${on}: no gateway in the list can serve it (${skipped.join('; ')}).${other ? ` Add ${gatewayHelper(other)} to gateway.` : ''}`,
  )
}

/** As `resolveModelGateway`, but undefined where it would throw, for checks the plan already makes. */
export function modelGatewayOrNone(
  model: JudgeModel | undefined,
  pin: GatewayName | GatewayDescriptor | undefined,
  scope: GatewayScope,
): GatewayName | undefined {
  try {
    return resolveModelGateway(model, pin, scope, 'model')
  } catch {
    return undefined
  }
}
