// `reeval/gateway`: the gateways a config's `gateway` list names, in preference order.
import type { DirectGatewayDescriptor } from './types.ts'

/**
 * Each provider's own key, as a config without `gateway` uses: the harness's own credential
 * (`CURSOR_API_KEY`, `ANTHROPIC_API_KEY`, …), brokered into its sandbox as today. It serves every
 * harness, so ending the list with it means nothing falls through.
 */
export const direct = (): DirectGatewayDescriptor => ({ kind: 'direct' })

export type {
  DirectGatewayDescriptor,
  GatewayDescriptor,
  GatewayName,
  ResolvedGateway,
} from './types.ts'
