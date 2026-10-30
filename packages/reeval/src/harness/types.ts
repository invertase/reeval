import type { HarnessSkill, ResolvedMcpServer } from '../environment/resolve.ts'
import type { Sandbox } from '../sandbox/types.ts'
import type { PluginPart, TokenUsage, TranscriptEvent, TurnStatus, WebEventType } from '../types.ts'

export type HarnessResult = {
  /** The agent's final message for the turn. */
  text: string
  status: TurnStatus
  startedAt: string
  durationMs: number
  transcript: TranscriptEvent[]
  /** Tokens the turn used, when the harness reports them. */
  usage: TokenUsage | null
  /** The model the harness says served the turn; null when it reports none. */
  model: string | null
  /** Event types the harness can't report, so their absence from `transcript` proves nothing. */
  unreported: WebEventType[]
  /** Every stream part as the harness sent it, only when `REEVAL_RAW_TRANSCRIPT` is set. */
  raw?: unknown[]
  /**
   * The turn's error, naming the variable, when the model API rejected the harness's credential:
   * the attempt is then an infra error, not the agent's failure.
   */
  rejectedKey?: string
}

/** One agent conversation in one sandbox. Each `send` is the next turn. */
export interface HarnessSession {
  send(prompt: string, signal: AbortSignal): Promise<HarnessResult>
  close(): Promise<void>
}

/** What an environment gives the agent itself; each adapter puts it where its agent looks. */
export type Treatments = {
  skills: HarnessSkill[]
  /** Skills already written into the workspace's skill directory (placement `workspace`). */
  workspaceSkills: string[]
  /** Secret values are already resolved. */
  mcp: Record<string, ResolvedMcpServer>
  /**
   * Plugins the session copied into the sandbox, each at `dir` (absolute) with the parts `only`
   * kept; the adapter makes its agent load them. `servers` are the keys of its MCP servers in
   * `mcp` (`<plugin>:<server>`, `${CLAUDE_PLUGIN_ROOT}` and secrets filled in), so an adapter whose
   * agent loads the plugin's own MCP config can leave them out of `mcp` rather than start them twice.
   */
  plugins: PlacedPlugin[]
}

/** A plugin the session copied into the sandbox. */
export type PlacedPlugin = { name: string; dir: string; parts: PluginPart[]; servers: string[] }

export interface Harness {
  start(sandbox: Sandbox, signal: AbortSignal, treatments: Treatments): Promise<HarnessSession>
}
