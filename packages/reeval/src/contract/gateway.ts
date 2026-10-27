// The gateways' plain-data contract: what `direct()`, `vercel()`, `openrouter()` and `vertex()` in
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
  VertexGatewayDescriptor,
  VertexPublisher,
} from '../types.ts'
import type { Assert, Same } from './shared.ts'

export const GATEWAY_NAMES = ['direct', 'vercel', 'openrouter', 'vertex'] as const

export const gatewayNameSchema = z.enum(GATEWAY_NAMES)

const directSettings = {
  enabled: z.boolean().optional(),
}

export const directGatewaySchema = z.strictObject({ kind: z.literal('direct'), ...directSettings })

/** Why `direct({ enabled: false })` can't be a pin: it turns a list's fallback off, not a route on. */
export const directOffPin = (on: string): string =>
  `${on} pins direct({ enabled: false }), which turns the fallback to each provider's own key off rather than naming a gateway. Pin direct(), or put direct({ enabled: false }) in the config's gateway list.`

export const vercelGatewaySchema = z.strictObject({ kind: z.literal('vercel') })

const openrouterSettings = {
  fallbacks: z.boolean().optional(),
}

export const openrouterGatewaySchema = z.strictObject({
  kind: z.literal('openrouter'),
  ...openrouterSettings,
})

export const VERTEX_PUBLISHERS = ['anthropic', 'google', 'xai'] as const

export const vertexPublisherSchema = z.enum(VERTEX_PUBLISHERS)

const region = z.string().regex(/^[a-z][a-z0-9-]*$/, 'a region such as us-east5 or global')

export const vertexGatewaySchema = z.strictObject({
  kind: z.literal('vertex'),
  project: z.string().min(1).optional(),
  location: region.optional(),
  regions: z.partialRecord(vertexPublisherSchema, region).optional(),
})

export const gatewayDescriptorSchema = z.discriminatedUnion('kind', [
  directGatewaySchema,
  vercelGatewaySchema,
  openrouterGatewaySchema,
  vertexGatewaySchema,
])

export const gatewayEntryDataSchema = z.union([
  gatewayNameSchema,
  z.strictObject({ direct: z.strictObject(directSettings) }),
  z.strictObject({ vercel: z.strictObject({}) }),
  z.strictObject({ openrouter: z.strictObject(openrouterSettings) }),
  z.strictObject({ vertex: vertexGatewaySchema.omit({ kind: true }) }),
  gatewayDescriptorSchema,
])

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof gatewayNameSchema>, GatewayName>>,
  Assert<Same<z.infer<typeof directGatewaySchema>, DirectGatewayDescriptor>>,
  Assert<Same<z.infer<typeof vercelGatewaySchema>, VercelGatewayDescriptor>>,
  Assert<Same<z.infer<typeof openrouterGatewaySchema>, OpenRouterGatewayDescriptor>>,
  Assert<Same<z.infer<typeof vertexPublisherSchema>, VertexPublisher>>,
  Assert<Same<z.infer<typeof vertexGatewaySchema>, VertexGatewayDescriptor>>,
  Assert<Same<z.infer<typeof gatewayDescriptorSchema>, GatewayDescriptor>>,
  Assert<Same<z.infer<typeof gatewayEntryDataSchema>, GatewayEntryData>>,
]
