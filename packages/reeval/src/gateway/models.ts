// Which gateway in the config's `gateway` list a model reeval calls itself goes through (the
// judge's, analysis's, a capture's): its pin, or the first entry that can serve the model.
import { GATEWAY_NAMES } from '../contract/gateway.ts'
import { UsageError } from '../errors.ts'
import {
  DIRECT_PROVIDERS,
  OPENROUTER_JUDGE_MODEL,
  RECOMMENDED_JUDGE_MODEL,
} from '../judge/index.ts'
import type {
  FakeAnalysisModel,
  GatewayDescriptor,
  GatewayName,
  JudgeModel,
  ResolvedConfig,
  ResolvedProfile,
} from '../types.ts'
import { gatewayHelper } from './resolve.ts'
import { vertexModelRefusal } from './vertex.ts'

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
  openrouter: () => undefined,
  vertex: vertexModelRefusal,
}

/** The run's gateway list: the profile's, else the config's (`[direct()]` when neither sets one). */
export type GatewayScope = { gateways: readonly GatewayDescriptor[] }

export const gatewayScope = (
  config: Pick<ResolvedConfig, 'gateway'>,
  profile?: Pick<ResolvedProfile, 'gateway'> | null,
): GatewayScope => ({ gateways: profile?.gateway ?? config.gateway })

/**
 * The gateway `model` goes through: its pin, or the first in the list that can serve it. An unset
 * list is `[direct()]`, so a model takes its provider's own key unless the config lists another
 * gateway. A model object or a fake calls through itself, and is undefined. Throws a UsageError
 * naming each gateway tried.
 */
export function resolveModelGateway(
  model: JudgeModel | FakeAnalysisModel | undefined,
  pin: GatewayName | GatewayDescriptor | undefined,
  scope: GatewayScope,
  what: string,
): GatewayName | undefined {
  // A model without a provider prefix is refused by its shape check, which says how to fix it.
  if (typeof model !== 'string' || !model.includes('/')) return undefined
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
  // Vercel AI Gateway and OpenRouter refuse a language model as a judge, which only a call can tell.
  const judge =
    other && other !== 'direct' && what.includes('judge')
      ? ` There a judge must be a decision model, such as '${other === 'openrouter' ? OPENROUTER_JUDGE_MODEL : RECOMMENDED_JUDGE_MODEL}'.`
      : ''
  throw new UsageError(
    `${on}: no gateway in the list can serve it (${skipped.join('; ')}).${other ? ` Add ${gatewayHelper(other)} to gateway.${judge}` : ''}`,
  )
}

/** As `resolveModelGateway`, but undefined where it would throw, for checks the plan already makes. */
export function modelGatewayOrNone(
  model: JudgeModel | FakeAnalysisModel | undefined,
  pin: GatewayName | GatewayDescriptor | undefined,
  scope: GatewayScope,
): GatewayName | undefined {
  try {
    return resolveModelGateway(model, pin, scope, 'model')
  } catch {
    return undefined
  }
}
