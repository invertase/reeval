// The gateways' plain-data contract: what `direct()`, `vercel()` and `openrouter()` in
// `reeval/gateway` return, the names a harness pins, and a `gateway` entry as `reeval.yaml` writes
// it. The types in types.ts are held to them by `_SameAsSchema`.
import { z } from 'zod'
import type {
  DirectGatewayDescriptor,
  GatewayDescriptor,
  GatewayEntryData,
  GatewayName,
  OpenRouterGatewayDescriptor,
  VercelGatewayDescriptor,
} from '../types.ts'
import type { Assert, Same } from './shared.ts'

export const GATEWAY_NAMES = ['direct', 'vercel', 'openrouter'] as const

export const gatewayNameSchema = z.enum(GATEWAY_NAMES)

export const directGatewaySchema = z.strictObject({ kind: z.literal('direct') })

export const vercelGatewaySchema = z.strictObject({ kind: z.literal('vercel') })

const openrouterSettings = {
  fallbacks: z.boolean().optional(),
}

export const openrouterGatewaySchema = z.strictObject({
  kind: z.literal('openrouter'),
  ...openrouterSettings,
})

export const gatewayDescriptorSchema = z.discriminatedUnion('kind', [
  directGatewaySchema,
  vercelGatewaySchema,
  openrouterGatewaySchema,
])

export const gatewayEntryDataSchema = z.union([
  gatewayNameSchema,
  z.strictObject({ direct: z.strictObject({}) }),
  z.strictObject({ vercel: z.strictObject({}) }),
  z.strictObject({ openrouter: z.strictObject(openrouterSettings) }),
  gatewayDescriptorSchema,
])

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof gatewayNameSchema>, GatewayName>>,
  Assert<Same<z.infer<typeof directGatewaySchema>, DirectGatewayDescriptor>>,
  Assert<Same<z.infer<typeof vercelGatewaySchema>, VercelGatewayDescriptor>>,
  Assert<Same<z.infer<typeof openrouterGatewaySchema>, OpenRouterGatewayDescriptor>>,
  Assert<Same<z.infer<typeof gatewayDescriptorSchema>, GatewayDescriptor>>,
  Assert<Same<z.infer<typeof gatewayEntryDataSchema>, GatewayEntryData>>,
]
