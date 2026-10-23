// `reeval/gateway`: the gateways a config's `gateway` list names, in preference order.
import type { DirectGatewayDescriptor, VercelGatewayDescriptor } from './types.ts'

/**
 * Each provider's own key, as a config without `gateway` uses: the harness's own credential
 * (`CURSOR_API_KEY`, `ANTHROPIC_API_KEY`, …), brokered into its sandbox as today. It serves every
 * harness, so ending the list with it means nothing falls through.
 */
export const direct = (): DirectGatewayDescriptor => ({ kind: 'direct' })

/**
 * Vercel AI Gateway: one key, `AI_GATEWAY_API_KEY` (else `VERCEL_OIDC_TOKEN`), for Claude Code and
 * Codex, brokered into the sandbox like a harness's own. A harness it can't serve takes the next
 * gateway in the list.
 */
export const vercel = (): VercelGatewayDescriptor => ({ kind: 'vercel' })

export type {
  DirectGatewayDescriptor,
  GatewayDescriptor,
  GatewayName,
  ResolvedGateway,
  VercelGatewayDescriptor,
} from './types.ts'
