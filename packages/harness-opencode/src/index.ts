// `@evalsuite/harness-opencode`: OpenCode on a Gemini API key, as an AI SDK harness over ACP.
export {
  createOpenCode,
  GEMINI_API_KEY_HEADER,
  GEMINI_API_URL,
  googleModel,
  OPENCODE_CLI_VERSION,
  OPENCODE_CREDENTIAL_ENV,
  OPENCODE_DENIED_TOOLS,
  OPENCODE_ENDPOINTS,
  OPENCODE_HARNESS_ID,
  OPENCODE_HOME_SKILLS_DIR,
  OPENCODE_WEB_SEARCH,
  OPENCODE_WORKSPACE_SKILLS_DIR,
  type OpenCodeConfigOptions,
  type OpenCodeHarnessSettings,
  type OpenCodeMcpServer,
  openCodeConfig,
  openCodeEnv,
} from './opencode-harness.ts'
export { OpenCodeStreamTranslator } from './opencode-stream.ts'
export { OPENCODE_BUILTIN_TOOLS, type OpenCodeBuiltinTools } from './opencode-tools.ts'
export { VERSION } from './version.ts'
