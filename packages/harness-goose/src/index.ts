// `@reeval/harness-goose`: Goose on a Gemini API key, Vercel AI Gateway or OpenRouter, as an AI SDK harness
// over ACP.
export {
  AI_GATEWAY_PROVIDER,
  createGoose,
  GEMINI_API_KEY_HEADER,
  GEMINI_API_URL,
  GEMINI_PROVIDER,
  GOOSE_CLI_SHA256,
  GOOSE_CLI_VERSION,
  GOOSE_CREDENTIAL_ENV,
  GOOSE_ENDPOINTS,
  GOOSE_HARNESS_ID,
  GOOSE_HOME_SKILLS_DIR,
  GOOSE_INSTALL_COMMAND,
  GOOSE_QUIET_ENV,
  GOOSE_WORKSPACE_SKILLS_DIR,
  type GooseHarnessSettings,
  type GooseProvider,
  gooseConfig,
  gooseEnv,
  OPENROUTER_PROVIDER,
} from './goose-harness.ts'
export { GooseStreamTranslator } from './goose-stream.ts'
export { GOOSE_BUILTIN_TOOLS, type GooseBuiltinTools } from './goose-tools.ts'
export { VERSION } from './version.ts'
