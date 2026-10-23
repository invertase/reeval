// The gateways' plain-data contract: what `direct()`, `vercel()` and `vertex()` in `reeval/gateway` return, the names a
// harness pins, and a `gateway` entry as `reeval.yaml` writes it. The types in types.ts are held
// to them by `_SameAsSchema`.
import { z } from 'zod'
import type {
  DirectGatewayDescriptor,
  GatewayDescriptor,
  GatewayEntryData,
  GatewayName,
  VercelGatewayDescriptor,
  VertexGatewayDescriptor,
  VertexPublisher,
} from '../types.ts'
import type { Assert, Same } from './shared.ts'

export const GATEWAY_NAMES = ['direct', 'vercel', 'vertex'] as const

export const gatewayNameSchema = z
  .enum(GATEWAY_NAMES)
  .describe(
    "A gateway the config lists by name: `direct` is each provider's own key, as without `gateway`; `vercel` is Vercel AI Gateway; `vertex` is Google Cloud's Vertex AI.",
  )

export const directGatewaySchema = z
  .strictObject({ kind: z.literal('direct') })
  .describe(
    "Each provider's own key, as without `gateway`: made by `direct()` in `reeval/gateway`.",
  )

export const vercelGatewaySchema = z
  .strictObject({ kind: z.literal('vercel') })
  .describe(
    'Vercel AI Gateway, with `AI_GATEWAY_API_KEY` (else `VERCEL_OIDC_TOKEN`): made by `vercel()` in `reeval/gateway`. It serves Claude Code, Codex, Goose, pi, OpenCode, fx and Grok Build.',
  )

export const VERTEX_PUBLISHERS = ['anthropic', 'google', 'xai'] as const

export const vertexPublisherSchema = z
  .enum(VERTEX_PUBLISHERS)
  .describe('A model publisher on Vertex AI, which may serve its models in a region of its own.')

const region = z.string().regex(/^[a-z][a-z0-9-]*$/, 'a region such as us-east5 or global')

export const vertexGatewaySchema = z
  .strictObject({
    kind: z.literal('vertex'),
    project: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The Google Cloud project the calls are billed to; defaults to `GOOGLE_CLOUD_PROJECT`.',
      ),
    location: region
      .optional()
      .describe('The region the models are called in, e.g. `us-east5`; defaults to `global`.'),
    regions: z
      .partialRecord(vertexPublisherSchema, region)
      .optional()
      .describe(
        "A region per publisher, where it differs from `location`, e.g. `{ anthropic: 'us-east5' }`.",
      ),
  })
  .describe(
    "Google Cloud's Vertex AI, on Application Default Credentials: made by `vertex()` in `reeval/gateway`.",
  )

export const gatewayDescriptorSchema = z
  .discriminatedUnion('kind', [directGatewaySchema, vercelGatewaySchema, vertexGatewaySchema])
  .describe("One entry of the config's `gateway` list.")

export const gatewayEntryDataSchema = z
  .union([
    gatewayNameSchema,
    z.strictObject({ direct: z.strictObject({}) }),
    z.strictObject({ vercel: z.strictObject({}) }),
    z.strictObject({ vertex: vertexGatewaySchema.omit({ kind: true }) }),
    gatewayDescriptorSchema,
  ])
  .describe(
    'A `gateway` entry as data (`reeval.yaml`): its name, a one-key map from its name to its settings, or the descriptor itself.',
  )

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof gatewayNameSchema>, GatewayName>>,
  Assert<Same<z.infer<typeof directGatewaySchema>, DirectGatewayDescriptor>>,
  Assert<Same<z.infer<typeof vercelGatewaySchema>, VercelGatewayDescriptor>>,
  Assert<Same<z.infer<typeof vertexPublisherSchema>, VertexPublisher>>,
  Assert<Same<z.infer<typeof vertexGatewaySchema>, VertexGatewayDescriptor>>,
  Assert<Same<z.infer<typeof gatewayDescriptorSchema>, GatewayDescriptor>>,
  Assert<Same<z.infer<typeof gatewayEntryDataSchema>, GatewayEntryData>>,
]
