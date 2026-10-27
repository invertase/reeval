// `@reeval/harness-grok-build`: xAI's Grok Build on an xAI API key, Vercel AI Gateway, OpenRouter or
// Vertex AI, as an AI SDK harness over ACP.
export {
  AI_GATEWAY_PROVIDER,
  createGrokBuild,
  GROK_BUILD_HARNESS_ID,
  GROK_CLI_INTEGRITY,
  GROK_CLI_VERSION,
  GROK_CREDENTIAL_ENV,
  GROK_ENDPOINTS,
  GROK_HOME_SKILLS_DIR,
  GROK_INSTALL_COMMAND,
  GROK_QUIET_ENV,
  GROK_WORKSPACE_SKILLS_DIR,
  type GrokBuildHarnessSettings,
  type GrokProvider,
  grokConfig,
  OPENROUTER_PROVIDER,
  VERTEX_TOKEN_ENV,
  vertexProvider,
  XAI_API_URL,
} from './grok-build-harness.ts'
export { GrokBuildStreamTranslator, grokTurnUsage } from './grok-build-stream.ts'
export { GROK_BUILD_BUILTIN_TOOLS, type GrokBuildBuiltinTools } from './grok-build-tools.ts'
export { VERSION } from './version.ts'
