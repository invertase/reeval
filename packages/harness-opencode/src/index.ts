// `@reeval/harness-opencode`: OpenCode on any brokerable provider, as an AI SDK harness over ACP.
export {
  createOpenCode,
  OPENCODE_CLI_VERSION,
  OPENCODE_DENIED_TOOLS,
  OPENCODE_HARNESS_ID,
  OPENCODE_HOME_SKILLS_DIR,
  OPENCODE_VERTEX_PROVIDER,
  OPENCODE_WEB_SEARCH,
  OPENCODE_WORKSPACE_SKILLS_DIR,
  type OpenCodeConfigOptions,
  type OpenCodeHarnessSettings,
  type OpenCodeMcpServer,
  type OpenCodeVertex,
  openCodeConfig,
  openCodeEffortBody,
  openCodeEndpoints,
  openCodeEnv,
} from './opencode-harness.ts'
export {
  OPENCODE_PROVIDERS,
  type OpenCodeEndpoint,
  type OpenCodeKeyHeader,
  type OpenCodeProvider,
  openCodeProvider,
  providerEndpoints,
  providerHosts,
  providerModelResponses,
  providerServedModel,
  providerTransformations,
  REFUSED_OPENCODE_PROVIDERS,
  type RefusedOpenCodeProvider,
  resolveOpenCodeProvider,
  splitModel,
} from './opencode-providers.ts'
export { OpenCodeStreamTranslator, openCodeTurnUsage } from './opencode-stream.ts'
export { OPENCODE_BUILTIN_TOOLS, type OpenCodeBuiltinTools } from './opencode-tools.ts'
export { VERSION } from './version.ts'
