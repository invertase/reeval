// `@reeval/harness-antigravity`: the Google Antigravity CLI (`agy`) as an AI SDK harness.
import { createAntigravity } from './antigravity-harness.ts'

/** Default Antigravity harness instance. Equivalent to `createAntigravity()`. */
export const antigravity = createAntigravity()

export {
  ANTIGRAVITY_BASE_URL_ENV,
  ANTIGRAVITY_CREDENTIAL_ENV,
  type AntigravityAuthentication,
  type AntigravityCredentials,
  antigravityEndpoints,
  createAntigravityRequestTransformations,
  GEMINI_API_KEY_HEADER,
  GEMINI_API_URL,
  resolveAntigravityCredentials,
} from './antigravity-auth.ts'
export {
  ANTIGRAVITY_BOOTSTRAP_DIR,
  ANTIGRAVITY_CLI_PATH,
  ANTIGRAVITY_CLI_SHA256,
  ANTIGRAVITY_CLI_VERSION,
  antigravityInstallScript,
  getAntigravityBootstrap,
} from './antigravity-bootstrap.ts'
export {
  type AntigravityCommandOptions,
  type AntigravityEffort,
  buildAntigravityCommand,
} from './antigravity-command.ts'
export {
  ANTIGRAVITY_HARNESS_ID,
  ANTIGRAVITY_HOME_SKILLS_DIR,
  ANTIGRAVITY_INSTRUCTIONS_FILE,
  ANTIGRAVITY_MCP_CONFIG_FILE,
  ANTIGRAVITY_SETTINGS_FILE,
  ANTIGRAVITY_WORKSPACE_RULES_FILE,
  ANTIGRAVITY_WORKSPACE_SKILLS_DIR,
  type AntigravityHarnessSettings,
  createAntigravity,
} from './antigravity-harness.ts'
export {
  type AntigravityEvent,
  type AntigravityResult,
  type AntigravityStepUpdate,
  AntigravityStreamTranslator,
  type AntigravityUsage,
  toUsage,
} from './antigravity-stream.ts'
export {
  ANTIGRAVITY_BUILTIN_TOOLS,
  type AntigravityBuiltinTools,
  type ProjectedToolCall,
  projectToolCall,
} from './antigravity-tools.ts'
export { VERSION } from './version.ts'
