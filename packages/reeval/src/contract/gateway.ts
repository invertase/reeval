// The gateways' plain-data contract: what `direct()` and `vercel()` in `reeval/gateway` return, the names a
// harness pins, and a `gateway` entry as `reeval.yaml` writes it. The types in types.ts are held
// to them by `_SameAsSchema`.
import { z } from 'zod'
import type {
  DirectGatewayDescriptor,
  GatewayDescriptor,
  GatewayEntryData,
  GatewayName,
  VercelGatewayDescriptor,
} from '../types.ts'
import type { Assert, Same } from './shared.ts'

export const GATEWAY_NAMES = ['direct', 'vercel'] as const

export const gatewayNameSchema = z
  .enum(GATEWAY_NAMES)
  .describe(
    "A gateway the config lists by name: `direct` is each provider's own key, as without `gateway`; `vercel` is Vercel AI Gateway.",
  )

export const directGatewaySchema = z
  .strictObject({ kind: z.literal('direct') })
  .describe(
    "Each provider's own key, as without `gateway`: made by `direct()` in `reeval/gateway`.",
  )

export const vercelGatewaySchema = z
  .strictObject({ kind: z.literal('vercel') })
  .describe(
    'Vercel AI Gateway, with `AI_GATEWAY_API_KEY` (else `VERCEL_OIDC_TOKEN`): made by `vercel()` in `reeval/gateway`. It serves Claude Code and Codex.',
  )

export const gatewayDescriptorSchema = z
  .discriminatedUnion('kind', [directGatewaySchema, vercelGatewaySchema])
  .describe("One entry of the config's `gateway` list.")

export const gatewayEntryDataSchema = z
  .union([
    gatewayNameSchema,
    z.strictObject({ direct: z.strictObject({}) }),
    z.strictObject({ vercel: z.strictObject({}) }),
    gatewayDescriptorSchema,
  ])
  .describe(
    'A `gateway` entry as data (`reeval.yaml`): its name, a one-key map from its name to its settings, or the descriptor itself.',
  )

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof gatewayNameSchema>, GatewayName>>,
  Assert<Same<z.infer<typeof directGatewaySchema>, DirectGatewayDescriptor>>,
  Assert<Same<z.infer<typeof vercelGatewaySchema>, VercelGatewayDescriptor>>,
  Assert<Same<z.infer<typeof gatewayDescriptorSchema>, GatewayDescriptor>>,
  Assert<Same<z.infer<typeof gatewayEntryDataSchema>, GatewayEntryData>>,
]
