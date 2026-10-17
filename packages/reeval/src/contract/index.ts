// The SDK-facing plain-data contract: the shapes another language's declaration tree carries,
// each a Zod schema that validates it, describes it and gives its JSON Schema.
import type { z } from 'zod'
import { dockerSandboxSchema, fakeSandboxSchema, installStepSchema } from './docker.ts'
import { durationSchema } from './shared.ts'

/**
 * The schemas that own a `$def` in schema/plan/, by its name there. scripts/schema/zod.ts puts
 * their JSON Schema in place of the one generated from the TypeScript type, and fails when the
 * two disagree on a property, whether it's required, or its description.
 */
export const CONTRACT_SCHEMAS: Record<string, z.ZodType> = {
  Duration: durationSchema,
  DockerSandboxDescriptor: dockerSandboxSchema,
  FakeSandboxDescriptor: fakeSandboxSchema,
  InstallStep: installStepSchema,
}
