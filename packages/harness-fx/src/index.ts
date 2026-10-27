// `@reeval/harness-fx`: fx on Vercel AI Gateway, OpenAI's API, OpenRouter or Vertex AI, as an AI SDK harness over ACP.
export {
  createFx,
  FX_CLI_SHA256,
  FX_CLI_VERSION,
  FX_HARNESS_ID,
  FX_HOME_SKILLS_DIR,
  FX_INSTALL_COMMAND,
  FX_PROVIDERS,
  FX_QUIET_ENV,
  FX_VERTEX_PROVIDER,
  FX_WORKSPACE_SKILLS_DIR,
  type FxHarnessSettings,
  type FxProvider,
  type FxVertex,
  fxEnv,
  fxProviderOf,
  fxSettings,
  fxVertexBaseUrl,
} from './fx-harness.ts'
export { FxStreamTranslator, fxMcpSegment } from './fx-stream.ts'
export { FX_BUILTIN_TOOLS, type FxBuiltinTools } from './fx-tools.ts'
export { VERSION } from './version.ts'
