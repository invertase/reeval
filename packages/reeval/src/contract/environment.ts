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
  skillSourceSchema,
} from './plain.ts'
import { type Assert, durationSchema, nonEmpty, type Same } from './shared.ts'

/** An environment's or layer's name, which names its cells. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/

export const sandboxDescriptorSchema = z.union([fakeSandboxSchema, dockerSandboxSchema])

export const setupStepSchema = z
  .union([
    nonEmpty(),
    z.strictObject({
      run: nonEmpty().describe('The shell command.'),
      timeout: durationSchema.optional().describe('Default 5m.'),
      cwd: nonEmpty()
        .optional()
        .describe('Relative to the workspace, or absolute; default the workspace.'),
    }),
  ])
  .describe(
    'Runs in every attempt before the agent starts, with secrets, outside the eval timeout: a shell command, or `{ run, timeout?, cwd? }`.',
  )

export const environmentSpecSchema = z
  .strictObject({
    sandbox: sandboxDescriptorSchema
      .optional()
      .describe(
        "Where the attempt runs: `docker()` or `fakeSandbox()`. A child's `extend` / `extendEnvironment` replaces the parent's entirely when it sets one; install is not merged onto the parent image.",
      ),
    workspace: gitWorkspaceSchema
      .optional()
      .describe(
        "The code the workspace starts as, before `files`, `rules` and `setup`; a child's replaces its parent's.",
      ),
    env: envVarsSchema
      .optional()
      .describe("Variables and secrets for the sandbox, merged by name over the parent's."),
    egress: egressPolicySchema
      .optional()
      .describe("Replaces the inherited policy; an `extend` child's replaces its parent's."),
    files: z
      .record(z.string(), z.union([z.string(), hostFileSchema]))
      .optional()
      .describe('Workspace-relative, or `~/` for home.'),
    rules: z
      .union([z.string(), hostFileSchema])
      .optional()
      .describe(
        "Project rules, written where the harness's agent reads them: `AGENTS.md`, or `CLAUDE.md` for Claude Code.",
      ),
    setup: z
      .array(setupStepSchema)
      .optional()
      .describe(
        "Shell commands run in every attempt before the agent starts; a child's run after its parent's.",
      ),
    skills: z.array(skillSourceSchema).optional().describe('Skills placed for the agent.'),
    mcp: z
      .record(z.string(), mcpServerSchema)
      .optional()
      .describe('MCP servers the agent gets, by name.'),
  })
  .describe('What an eval runs in: the declarative, phased spec of one environment.')

export const environmentLayerSchema = z
  .strictObject({
    name: z.string().regex(NAME).describe('The name passed to `defineEnvironment` or `extend`.'),
    spec: environmentSpecSchema.describe('The spec as that layer wrote it, before merging.'),
  })
  .describe('One environment in an `extend` chain.')

export const environmentDataSchema = z
  .strictObject({
    kind: z.literal('environment'),
    name: z
      .string()
      .regex(NAME)
      .describe('The name it was defined or extended under, which names its cells.'),
    layers: z.array(environmentLayerSchema).readonly().describe('Its `extend` chain, root first.'),
  })
  .describe('An `Environment` as data, as JSON carries it: without `extend` / `extendEnvironment`.')

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof sandboxDescriptorSchema>, SandboxDescriptor>>,
  Assert<Same<z.infer<typeof setupStepSchema>, SetupStep>>,
  Assert<Same<z.infer<typeof environmentSpecSchema>, EnvironmentSpec>>,
  Assert<Same<keyof z.infer<typeof environmentSpecSchema>, keyof EnvironmentSpec>>,
  Assert<Same<z.infer<typeof environmentLayerSchema>, EnvironmentLayer>>,
  Assert<Same<z.infer<typeof environmentDataSchema>, EnvironmentData>>,
  Assert<Same<keyof z.infer<typeof environmentDataSchema>, keyof EnvironmentData>>,
]
