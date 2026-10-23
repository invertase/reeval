// `reeval/gateway`: the gateways a config's `gateway` list names, in preference order.
import type {
  DirectGatewayDescriptor,
  OpenRouterGatewayDescriptor,
  VercelGatewayDescriptor,
  VertexGatewayDescriptor,
} from './types.ts'

/**
 * Each provider's own key, as a config without `gateway` uses: the harness's own credential
 * (`CURSOR_API_KEY`, `ANTHROPIC_API_KEY`, …), brokered into its sandbox as today. It serves every
 * harness, so ending the list with it means nothing falls through.
 */
export const direct = (): DirectGatewayDescriptor => ({ kind: 'direct' })

/**
 * Vercel AI Gateway: one key, `AI_GATEWAY_API_KEY` (else `VERCEL_OIDC_TOKEN`), brokered into the
 * sandbox like a harness's own. A harness it can't serve takes the next gateway in the list.
 */
export const vercel = (): VercelGatewayDescriptor => ({ kind: 'vercel' })

/**
 * OpenRouter: one key, `OPENROUTER_API_KEY`, brokered into the sandbox like a harness's own. A
 * harness it can't serve takes the next gateway in the list. `fallbacks: true` lets OpenRouter
 * fail over between upstream providers on reeval's own calls; either way each call records the
 * upstream that served it.
 */
export const openrouter = (
  options: Omit<OpenRouterGatewayDescriptor, 'kind'> = {},
): OpenRouterGatewayDescriptor => ({
  kind: 'openrouter',
  ...(options.fallbacks !== undefined ? { fallbacks: options.fallbacks } : {}),
})

/**
 * Google Cloud's Vertex AI, on Application Default Credentials: `project` defaults to
 * `GOOGLE_CLOUD_PROJECT` and `location` to `global`, and `regions` names a publisher's own region
 * where it differs.
 */
export const vertex = (
  options: Omit<VertexGatewayDescriptor, 'kind'> = {},
): VertexGatewayDescriptor => ({ kind: 'vertex', ...options })

export type {
  DirectGatewayDescriptor,
  GatewayDescriptor,
  GatewayName,
  OpenRouterGatewayDescriptor,
  ResolvedGateway,
  VercelGatewayDescriptor,
  VertexGatewayDescriptor,
  VertexPublisher,
} from './types.ts'
