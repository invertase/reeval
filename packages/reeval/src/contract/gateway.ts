// The gateways' plain-data contract: what `direct()` in `reeval/gateway` and `fakeGateway()` in
// `reeval/testing` return, the names a harness pins, and a `gateway` entry as `reeval.yaml`
// writes it. The types in types.ts are held to them by `_SameAsSchema`.
import { z } from 'zod'
import type {
  DirectGatewayDescriptor,
  FakeGatewayDescriptor,
  GatewayDescriptor,
  GatewayEntryData,
  GatewayName,
  HarnessDescriptor,
} from '../types.ts'
import type { Assert, Same } from './shared.ts'

export const GATEWAY_NAMES = ['direct', 'fake'] as const

/** Every harness kind, for what a fake gateway serves. */
export const HARNESS_KINDS = [
  'fake',
  'cursor',
  'claude-code',
  'antigravity',
  'opencode',
  'goose',
  'pi',
  'codex',
  'fx',
  'grok-build',
] as const

export const gatewayNameSchema = z
  .enum(GATEWAY_NAMES)
  .describe(
    "A gateway the config lists by name: `direct` is each provider's own key, as without `gateway`.",
  )

export const directGatewaySchema = z
  .strictObject({ kind: z.literal('direct') })
  .describe(
    "Each provider's own key, as without `gateway`: made by `direct()` in `reeval/gateway`.",
  )

export const fakeGatewaySchema = z
  .strictObject({
    kind: z.literal('fake'),
    serves: z
      .array(z.enum(HARNESS_KINDS))
      .optional()
      .describe("The harness kinds it serves; default `['fake']`."),
  })
  .describe(
    'A gateway for tests that serves only the harness kinds it lists, made by `fakeGateway()` in `reeval/testing`. Nothing changes inside an attempt it serves.',
  )

export const gatewayDescriptorSchema = z
  .discriminatedUnion('kind', [directGatewaySchema, fakeGatewaySchema])
  .describe("One entry of the config's `gateway` list.")

export const gatewayEntryDataSchema = z
  .union([
    gatewayNameSchema,
    z.strictObject({ direct: z.strictObject({}) }),
    z.strictObject({ fake: fakeGatewaySchema.omit({ kind: true }) }),
    gatewayDescriptorSchema,
  ])
  .describe(
    'A `gateway` entry as data (`reeval.yaml`): its name, a one-key map from its name to its settings, or the descriptor itself.',
  )

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof gatewayNameSchema>, GatewayName>>,
  Assert<Same<z.infer<typeof directGatewaySchema>, DirectGatewayDescriptor>>,
  Assert<Same<z.infer<typeof fakeGatewaySchema>, FakeGatewayDescriptor>>,
  Assert<Same<keyof z.infer<typeof fakeGatewaySchema>, keyof FakeGatewayDescriptor>>,
  Assert<Same<z.infer<typeof gatewayDescriptorSchema>, GatewayDescriptor>>,
  Assert<Same<z.infer<typeof gatewayEntryDataSchema>, GatewayEntryData>>,
  Assert<Same<(typeof HARNESS_KINDS)[number], HarnessDescriptor['kind']>>,
]
