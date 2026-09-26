// `@evalsuite/harness-opencode`: OpenCode on a Gemini API key, as an AI SDK harness over ACP.
export {
  createOpenCode,
  GEMINI_API_KEY_HEADER,
  GEMINI_API_URL,
  googleModel,
  OPENCODE_CLI_VERSION,
  OPENCODE_CREDENTIAL_ENV,
  OPENCODE_ENDPOINTS,
  OPENCODE_HARNESS_ID,
  OPENCODE_HOME_SKILLS_DIR,
  OPENCODE_QUIET_ENV,
  OPENCODE_WARM_COMMAND,
  OPENCODE_WORKSPACE_SKILLS_DIR,
  type OpenCodeHarnessSettings,
} from './opencode-harness.ts'
export { OpenCodeStreamTranslator } from './opencode-stream.ts'
export { OPENCODE_BUILTIN_TOOLS, type OpenCodeBuiltinTools } from './opencode-tools.ts'
export { VERSION } from './version.ts'
