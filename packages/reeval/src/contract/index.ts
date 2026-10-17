// The SDK-facing plain-data contract: the shapes another language's declaration tree carries,
// each a Zod schema that validates it, describes it and gives its JSON Schema.
import type { z } from 'zod'
import { compareQuestionSchema, pairFactorSchema } from './compare.ts'
import { dockerSandboxSchema, fakeSandboxSchema, installStepSchema } from './docker.ts'
import {
  environmentDataSchema,
  environmentLayerSchema,
  environmentSpecSchema,
  sandboxDescriptorSchema,
  setupStepSchema,
} from './environment.ts'
import {
  antigravityHarnessSchema,
  claudeCodeHarnessSchema,
  codexHarnessSchema,
  cursorHarnessSchema,
  fakeHarnessSchema,
  fakeScriptStepSchema,
  gooseHarnessSchema,
  harnessDescriptorSchema,
  opencodeHarnessSchema,
  piHarnessSchema,
} from './harness.ts'
import { judgeStateSchema } from './judge.ts'
import {
  egressPolicySchema,
  envValueSchema,
  envVarsSchema,
  gatePolicySchema,
  gitWorkspaceSchema,
  hostFileSchema,
  mcpServerSchema,
  secretSchema,
  secretTemplateSchema,
  skillPlacementSchema,
  skillSourceSchema,
  substituteInSchema,
} from './plain.ts'
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
  HarnessDescriptor: harnessDescriptorSchema,
  FakeHarnessDescriptor: fakeHarnessSchema,
  FakeScriptStep: fakeScriptStepSchema,
  CursorHarnessDescriptor: cursorHarnessSchema,
  ClaudeCodeHarnessDescriptor: claudeCodeHarnessSchema,
  AntigravityHarnessDescriptor: antigravityHarnessSchema,
  OpenCodeHarnessDescriptor: opencodeHarnessSchema,
  GooseHarnessDescriptor: gooseHarnessSchema,
  PiHarnessDescriptor: piHarnessSchema,
  CodexHarnessDescriptor: codexHarnessSchema,
  JudgeStateOptions: judgeStateSchema,
  CompareQuestion: compareQuestionSchema,
  PairFactor: pairFactorSchema,
  GatePolicy: gatePolicySchema,
  EgressPolicy: egressPolicySchema,
  Secret: secretSchema,
  SecretTemplate: secretTemplateSchema,
  SubstituteIn: substituteInSchema,
  EnvValue: envValueSchema,
  EnvVars: envVarsSchema,
  HostFile: hostFileSchema,
  SkillPlacement: skillPlacementSchema,
  SkillSource: skillSourceSchema,
  McpServer: mcpServerSchema,
  GitWorkspace: gitWorkspaceSchema,
  SandboxDescriptor: sandboxDescriptorSchema,
  SetupStep: setupStepSchema,
  EnvironmentSpec: environmentSpecSchema,
  EnvironmentLayer: environmentLayerSchema,
  EnvironmentData: environmentDataSchema,
}
