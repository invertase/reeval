// Runs coding-agent harnesses on a runner and records what they did. It knows nothing of evals
// or of where it runs: test/boundary.test.ts holds both.

export type {
  AgentKind,
  HarnessCatalogEntry,
  HarnessEntry,
  HarnessUsage,
  ReasoningDelivery,
  StoredUsage,
} from './catalog/entry.ts'
export { HARNESSES } from './catalog/index.ts'
export { agentMcp, FAKE_LAYOUT, LAYOUTS, type Layout } from './catalog/layouts.ts'
export {
  acpMcpServers,
  antigravityMcpServers,
  claudeMcpServers,
  codexMcpServers,
  cursorMcpServers,
  fxMcpServers,
  gooseMcpServers,
  opencodeMcpServers,
  piMcpServers,
} from './catalog/mcp.ts'
export {
  CLAUDE_FORMAT_PARTS,
  CLAUDE_PLUGIN_MARKETPLACE,
  claudePluginFiles,
  cursorHookMatcher,
  opencodeFrontmatter,
} from './catalog/plugins.ts'
export { providerOf, withoutProvider } from './catalog/provider-model.ts'
export { claudeCodeCost, cursorUnreported, piCost } from './catalog/reported.ts'
export {
  BUILTIN_SKILL_DIRS,
  SKILL_DIRS,
  SKILL_LAYOUTS,
  type SkillLayout,
} from './catalog/skill-dirs.ts'
export {
  everyCallFailed,
  harnessUsage,
  interactiveTools,
  type ModelTraffic,
  observed,
  REFUSED_KEY,
  rejectedKey,
  type StartAgentOptions,
  startAgent,
  turnCosts,
} from './driver/agent.ts'
export { type ProviderStop, providerStop } from './driver/provider-stop.ts'
export {
  errorText,
  normalizeStream,
  reasoningTime,
  STALL_TOOL_MS,
  type StampedPart,
  timesReasoning,
} from './driver/transcript.ts'
export type { AgentLog, AgentLogPhase, HarnessResult, HarnessSession } from './driver/types.ts'
export { AgentError } from './errors.ts'
export { type LocalOptions, local } from './local.ts'
export { masked, OUTPUT_CAP, type OutOptions } from './out/index.ts'
export type { OutSession, OutTranscriptLine, OutTurn } from './out/types.ts'
export { anthropicPath, apiHost, openaiPath, type RouteApi } from './routes/api.ts'
export { everyModel, notGemini } from './routes/effort.ts'
export { openCodeModelOn, ROUTES, type RouteName } from './routes/index.ts'
export {
  anthropicOnOpenRouter,
  OPENROUTER_API,
  OPENROUTER_HOST,
  OPENROUTER_KEY,
  OPENROUTER_ROUTE,
} from './routes/openrouter.ts'
export type { Route, RouteConfig } from './routes/route.ts'
export {
  jwtExpiry,
  VERCEL_API,
  VERCEL_BASE_URL,
  VERCEL_HOST,
  VERCEL_KEY,
  VERCEL_OIDC,
  VERCEL_ROUTE,
  vercelApi,
  vercelBaseUrl,
  vercelBaseUrlProblem,
  vercelCredential,
  vercelCredentialProblem,
} from './routes/vercel.ts'
export {
  fxVertexId,
  openCodeVertexId,
  VERTEX_AGENT_PROVIDERS,
  VERTEX_PROJECT_ENV,
  VERTEX_REFUSALS,
  VERTEX_ROUTES,
  type VertexPublisher,
  type VertexSettings,
  vertexClaudeId,
  vertexHarnessModel,
  vertexHost,
  vertexRegion,
  vertexXaiId,
} from './routes/vertex.ts'
export type { Proc, ProcExit, Runner, RunnerInfo, SpawnOptions } from './runner.ts'
export { withFallbacks } from './runner.ts'
export { type RunnerSessionOptions, runnerSession } from './runner-session.ts'
export {
  type AdapterInput,
  type Agent,
  type AgentEvent,
  type AgentHarness,
  type AgentOptions,
  type AgentPhase,
  type AgentSession,
  type AgentSkill,
  type AgentTurn,
  agent,
} from './session.ts'
export {
  PLUGIN_DIR,
  PLUGIN_PARTS,
  type PlacedPlugin,
  type PluginFile,
  type PluginPart,
  type PluginUnpack,
  type ResolvedMcpServer,
} from './spec.ts'
export type {
  CostUsd,
  EventTime,
  FileEditEvent,
  ModelCallEvent,
  ProviderStopRecord,
  TokenUsage,
  TranscriptEvent,
  TurnStatus,
  WebEventType,
} from './types.ts'
export { addUsage, promptTokens, sumUsage, tokenUsage, totalTokens } from './usage.ts'
export { AGENTS_VERSION } from './version.ts'
