// An environment's plain-data contract: the spec one layer writes, its setup steps, and the
// environment as a declaration tree carries it (`EnvironmentData`: a name and its layers, root
// first). `defineEnvironment` checks a spec in its own words first; the schema is the backstop
// for anything those checks don't name, and the source of the JSON Schema in schema/plan/.
import { z } from 'zod'
import type {
  EnvironmentData,
  EnvironmentLayer,
  EnvironmentSpec,
  SandboxDescriptor,
  SetupStep,
} from '../types.ts'
import { dockerSandboxSchema, fakeSandboxSchema } from './docker.ts'
import {
  egressPolicySchema,
  envVarsSchema,
  gitWorkspaceSchema,
  hostFileSchema,
  mcpServerSchema,
  pluginSourceSchema,
  skillSourceSchema,
} from './plain.ts'
import { type Assert, durationSchema, nonEmpty, type Same } from './shared.ts'

/** An environment's or layer's name, which names its cells. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/

export const sandboxDescriptorSchema = z.union([fakeSandboxSchema, dockerSandboxSchema])

export const setupStepSchema = z.union([
  nonEmpty(),
  z.strictObject({
    run: nonEmpty(),
    timeout: durationSchema.optional(),
    cwd: nonEmpty().optional(),
  }),
])

export const traitsSchema = z
  .record(z.string(), z.union([z.string(), z.array(z.string()).readonly()]))
  .readonly()

export const environmentSpecSchema = z.strictObject({
  sandbox: sandboxDescriptorSchema.optional(),
  workspace: gitWorkspaceSchema.optional(),
  env: envVarsSchema.optional(),
  egress: egressPolicySchema.optional(),
  files: z.record(z.string(), z.union([z.string(), hostFileSchema])).optional(),
  rules: z.union([z.string(), hostFileSchema]).optional(),
  setup: z.array(setupStepSchema).optional(),
  skills: z.array(skillSourceSchema).optional(),
  mcp: z.record(z.string(), mcpServerSchema).optional(),
  plugins: z.array(pluginSourceSchema).optional(),
  traits: z
    .record(z.string(), z.union([z.string(), z.array(z.string()).readonly()]))
    .readonly()
    .optional(),
})

export const environmentLayerSchema = z.strictObject({
  name: z.string().regex(NAME),
  spec: environmentSpecSchema,
})

export const environmentDataSchema = z.strictObject({
  kind: z.literal('environment'),
  name: z.string().regex(NAME),
  layers: z.array(environmentLayerSchema).readonly(),
})

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof sandboxDescriptorSchema>, SandboxDescriptor>>,
  Assert<Same<z.infer<typeof setupStepSchema>, SetupStep>>,
  Assert<Same<z.infer<typeof environmentSpecSchema>, EnvironmentSpec>>,
  Assert<Same<keyof z.infer<typeof environmentSpecSchema>, keyof EnvironmentSpec>>,
  Assert<Same<z.infer<typeof environmentLayerSchema>, EnvironmentLayer>>,
  Assert<Same<z.infer<typeof environmentDataSchema>, EnvironmentData>>,
  Assert<Same<keyof z.infer<typeof environmentDataSchema>, keyof EnvironmentData>>,
]
