// `@reeval/harness-fx`: fx on Vercel AI Gateway or OpenAI's API, as an AI SDK harness over ACP.
export {
  createFx,
  FX_CLI_SHA256,
  FX_CLI_VERSION,
  FX_HARNESS_ID,
  FX_HOME_SKILLS_DIR,
  FX_INSTALL_COMMAND,
  FX_PROVIDERS,
  FX_QUIET_ENV,
  FX_WORKSPACE_SKILLS_DIR,
  type FxHarnessSettings,
  type FxProvider,
  fxEnv,
  fxProviderOf,
  fxSettings,
} from './fx-harness.ts'
export { FxStreamTranslator, fxMcpSegment } from './fx-stream.ts'
export { FX_BUILTIN_TOOLS, type FxBuiltinTools } from './fx-tools.ts'
export { VERSION } from './version.ts'
