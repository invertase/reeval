// The SDK-facing plain-data contract: the shapes another language's declaration tree carries,
// each a Zod schema that validates it and gives its JSON Schema, described by the TSDoc of the
// hand-written type of the same name.
import type { z } from 'zod'
import {
  analysisConfigDataSchema,
  budgetSchema,
  captureOptionsSchema,
  captureWindowSchema,
  fakeAnalysisDataSchema,
  historyConfigSchema,
  profileDataSchema,
  profileDefaultsDataSchema,
  profileLimitSchema,
  reevalConfigDataSchema,
} from './config.ts'
import {
  declarationTreeSchema,
  declaredEvalSchema,
  declaredFamilySchema,
  declaredGroupSchema,
  declaredModeSchema,
  declaredNodeSchema,
  declaredSourceSchema,
  declaredTodoSchema,
  evalOptionsDataSchema,
} from './declaration.ts'
import { dockerSandboxSchema, fakeSandboxSchema, installStepSchema } from './docker.ts'
import {
  environmentDataSchema,
  environmentLayerSchema,
  environmentSpecSchema,
  sandboxDescriptorSchema,
  setupStepSchema,
} from './environment.ts'
import {
  directGatewaySchema,
  gatewayDescriptorSchema,
  gatewayEntryDataSchema,
  gatewayNameSchema,
  openrouterGatewaySchema,
  vercelGatewaySchema,
  vertexGatewaySchema,
} from './gateway.ts'
import {
  antigravityHarnessSchema,
  claudeCodeHarnessSchema,
  codexHarnessSchema,
  cursorHarnessSchema,
  fakeHarnessSchema,
  fakeScriptStepSchema,
  fxHarnessSchema,
  gooseHarnessSchema,
  grokBuildHarnessSchema,
  harnessDescriptorSchema,
  opencodeHarnessSchema,
  piHarnessSchema,
} from './harness.ts'
import { configJudgeDataSchema, fakeJudgeDataSchema } from './judge.ts'
import {
  egressPolicySchema,
  envValueSchema,
  envVarsSchema,
  gatePolicySchema,
  gitWorkspaceSchema,
  hostFileSchema,
  mcpServerSchema,
  pluginMarketplaceSchema,
  pluginPartSchema,
  pluginSourceSchema,
  secretSchema,
  secretTemplateSchema,
  skillPlacementSchema,
  skillSourceSchema,
  substituteInSchema,
} from './plain.ts'
import { pairFactorSchema, questionOptionsSchema, questionSchema } from './questions.ts'
import { durationSchema, jsonValueSchema } from './shared.ts'

/**
 * The schemas that own a `$def` in schema/plan/, by its name there. scripts/schema/zod.ts puts
 * their JSON Schema in place of the one generated from the TypeScript type, with that type's
 * TSDoc as its descriptions, and fails when the two disagree on a property or whether it's
 * required, or when a `.describe()` repeats or contradicts the TSDoc.
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
  FxHarnessDescriptor: fxHarnessSchema,
  GrokBuildHarnessDescriptor: grokBuildHarnessSchema,
  GatewayName: gatewayNameSchema,
  GatewayDescriptor: gatewayDescriptorSchema,
  DirectGatewayDescriptor: directGatewaySchema,
  VercelGatewayDescriptor: vercelGatewaySchema,
  OpenRouterGatewayDescriptor: openrouterGatewaySchema,
  VertexGatewayDescriptor: vertexGatewaySchema,
  GatewayEntryData: gatewayEntryDataSchema,
  Question: questionSchema,
  QuestionOptions: questionOptionsSchema,
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
  PluginPart: pluginPartSchema,
  PluginMarketplace: pluginMarketplaceSchema,
  PluginSource: pluginSourceSchema,
  McpServer: mcpServerSchema,
  GitWorkspace: gitWorkspaceSchema,
  SandboxDescriptor: sandboxDescriptorSchema,
  SetupStep: setupStepSchema,
  EnvironmentSpec: environmentSpecSchema,
  EnvironmentLayer: environmentLayerSchema,
  EnvironmentData: environmentDataSchema,
  DeclarationTree: declarationTreeSchema,
  DeclaredNode: declaredNodeSchema,
  DeclaredGroup: declaredGroupSchema,
  DeclaredEval: declaredEvalSchema,
  DeclaredFamily: declaredFamilySchema,
  DeclaredSource: declaredSourceSchema,
  DeclaredTodo: declaredTodoSchema,
  DeclaredMode: declaredModeSchema,
  ReevalConfigData: reevalConfigDataSchema,
  ProfileData: profileDataSchema,
  ProfileDefaultsData: profileDefaultsDataSchema,
  ProfileLimit: profileLimitSchema,
  Budget: budgetSchema,
  HistoryConfig: historyConfigSchema,
  ConfigJudgeData: configJudgeDataSchema,
  FakeJudgeData: fakeJudgeDataSchema,
  CaptureOptions: captureOptionsSchema,
  CaptureWindow: captureWindowSchema,
  AnalysisConfigData: analysisConfigDataSchema,
  FakeAnalysisData: fakeAnalysisDataSchema,
}

/**
 * Schemas registered only so the contract's JSON Schema refers to them by name: their `$def`
 * stays the one generated from the type, since another check validates them in its own words.
 */
export const CONTRACT_REFS: Record<string, z.ZodType> = {
  EvalOptionsData: evalOptionsDataSchema,
  JSONValue: jsonValueSchema,
}
