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

export const gatewayNameSchema = z
  .enum(GATEWAY_NAMES)
  .describe(
    "A gateway the config lists by name: `direct` is each provider's own key, as without `gateway`; `vercel` is Vercel AI Gateway; `openrouter` is OpenRouter.",
  )

export const directGatewaySchema = z
  .strictObject({ kind: z.literal('direct') })
  .describe(
    "Each provider's own key, as without `gateway`: made by `direct()` in `reeval/gateway`.",
  )

export const vercelGatewaySchema = z
  .strictObject({ kind: z.literal('vercel') })
  .describe(
    'Vercel AI Gateway, with `AI_GATEWAY_API_KEY` (else `VERCEL_OIDC_TOKEN`): made by `vercel()` in `reeval/gateway`. It serves Claude Code, Codex, Goose, OpenCode, fx and Grok Build.',
  )

const openrouterSettings = {
  fallbacks: z
    .boolean()
    .optional()
    .describe(
      "Let OpenRouter fail over to another upstream provider when the one it picked can't serve a call. Off by default, so reeval's own calls (the judge, analysis, compare questions and captures) send `allow_fallbacks: false`. The harnesses' calls take OpenRouter's own routing either way.",
    ),
}

export const openrouterGatewaySchema = z
  .strictObject({ kind: z.literal('openrouter'), ...openrouterSettings })
  .describe(
    'OpenRouter, with `OPENROUTER_API_KEY`: made by `openrouter()` in `reeval/gateway`. It serves Claude Code, Codex, Goose, OpenCode and Grok Build.',
  )

export const gatewayDescriptorSchema = z
  .discriminatedUnion('kind', [directGatewaySchema, vercelGatewaySchema, openrouterGatewaySchema])
  .describe("One entry of the config's `gateway` list.")

export const gatewayEntryDataSchema = z
  .union([
    gatewayNameSchema,
    z.strictObject({ direct: z.strictObject({}) }),
    z.strictObject({ vercel: z.strictObject({}) }),
    z.strictObject({ openrouter: z.strictObject(openrouterSettings) }),
    gatewayDescriptorSchema,
  ])
  .describe(
    'A `gateway` entry as data (`reeval.yaml`): its name, a one-key map from its name to its settings, or the descriptor itself.',
  )

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof gatewayNameSchema>, GatewayName>>,
  Assert<Same<z.infer<typeof directGatewaySchema>, DirectGatewayDescriptor>>,
  Assert<Same<z.infer<typeof vercelGatewaySchema>, VercelGatewayDescriptor>>,
  Assert<Same<z.infer<typeof openrouterGatewaySchema>, OpenRouterGatewayDescriptor>>,
  Assert<Same<z.infer<typeof gatewayDescriptorSchema>, GatewayDescriptor>>,
  Assert<Same<z.infer<typeof gatewayEntryDataSchema>, GatewayEntryData>>,
]
