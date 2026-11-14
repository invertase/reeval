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
export { AgentError } from './errors.ts'
export { type LocalOptions, local } from './local.ts'
export type { Proc, ProcExit, Runner, RunnerInfo, SpawnOptions } from './runner.ts'
export { withFallbacks } from './runner.ts'
export { type RunnerSessionOptions, runnerSession } from './runner-session.ts'
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
