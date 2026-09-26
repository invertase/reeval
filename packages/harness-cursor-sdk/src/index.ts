// `@evalsuite/harness-cursor-sdk`: Cursor's agent, through the Cursor TypeScript SDK, as an AI SDK harness.
import { createCursorSdk } from './cursor-sdk-harness.ts'

/** Default Cursor SDK harness instance. Equivalent to `createCursorSdk()`. */
export const cursorSdk = createCursorSdk()

export {
  CURSOR_API_URL,
  CURSOR_BACKEND_URL,
  CURSOR_SDK_CREDENTIAL_ENV,
  CURSOR_SDK_MODEL_CATALOG_ENV,
  type CursorSdkAuthentication,
  type CursorSdkCredentials,
  type CursorSdkModelEntry,
  catalogFor,
  createCursorSdkRequestTransformations,
  cursorSdkEndpoints,
  fetchCursorModelCatalog,
  resolveCursorSdkCredentials,
} from './cursor-sdk-auth.ts'
export {
  CURSOR_SDK_BOOTSTRAP_DIR,
  CURSOR_SDK_MIN_NODE,
  CURSOR_SDK_RECOVERED_TOOLS,
  CURSOR_SDK_RUNNER,
  CURSOR_SDK_RUNNER_PATH,
  CURSOR_SDK_VERSION,
  cursorSdkInstallScript,
  getCursorSdkBootstrap,
  type StoredWebCall,
  storedShapeProblems,
  storedWebCalls,
} from './cursor-sdk-bootstrap.ts'
export {
  CURSOR_SDK_HARNESS_ID,
  CURSOR_SDK_HOME_SKILLS_DIR,
  CURSOR_SDK_WORKSPACE_RULES_FILE,
  CURSOR_SDK_WORKSPACE_SKILLS_DIR,
  type CursorSdkHarnessSettings,
  type CursorSdkSettingSource,
  createCursorSdk,
} from './cursor-sdk-harness.ts'
export {
  type CursorSdkMessage,
  type CursorSdkModel,
  type CursorSdkResult,
  type CursorSdkRunnerLine,
  CursorSdkStreamTranslator,
  type CursorSdkUsage,
  toUsage,
} from './cursor-sdk-stream.ts'
export {
  CURSOR_SDK_BUILTIN_TOOLS,
  type CursorSdkBuiltinTools,
  type ProjectedToolCall,
  type ProjectedToolResult,
  projectToolCall,
  projectToolResult,
} from './cursor-sdk-tools.ts'
export { VERSION } from './version.ts'
