import type { PlacedPlugin } from '@reeval/agents'
import type { HarnessSkill, ResolvedMcpServer } from '../environment/resolve.ts'
import type { Sandbox } from '../sandbox/types.ts'
import type { CostUsd, TokenUsage, TranscriptEvent, TurnStatus, WebEventType } from '../types.ts'
import type { ProviderStop } from './provider-stop.ts'

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
  /**
   * Milliseconds the agent spent reasoning in the turn, from the reasoning blocks it streamed;
   * null when the harness can't time its reasoning, and absent for the fake harness, whose
   * reasoning events carry their own durations.
   */
  reasoningMs?: number | null
  /**
   * The turn's agent time, recorded in place of the wall clock around `send`; only the fake
   * harness's `turnMs` sets it.
   */
  agentMs?: number
  /** What the harness said the turn cost, when it says. */
  cost?: CostUsd
  /** Every stream part as the harness sent it, only when `REEVAL_RAW_TRANSCRIPT` is set. */
  raw?: unknown[]
  /**
   * The tokens of each step the harness reported, in order, which tell the turn's own model
   * calls from its CLI's side calls. Not recorded.
   */
  steps?: TokenUsage[]
  /**
   * The turn's error, naming the variable, when the model API rejected the harness's credential:
   * the attempt is then an infra error, not the agent's failure.
   */
  rejectedKey?: string
  /** When the model provider, not the agent, ended the turn: the attempt is then an infra error. */
  providerStop?: ProviderStop
}

/** One agent conversation in one sandbox. Each `send` is the next turn. */
export interface HarnessSession {
  send(prompt: string, signal: AbortSignal): Promise<HarnessResult>
  /**
   * The running turn as far as it got, for a turn that didn't stop when aborted and that reeval
   * stopped waiting for: what the agent streamed, with `note` (why reeval stopped waiting) last,
   * and the usage its CLI stored.
   */
  stopped?(note: TranscriptEvent): Promise<HarnessResult>
  /**
   * Reads the usage the running turn's CLI stored so far, for the turn's result: reeval calls it
   * when the attempt is cut off, before it removes the sandbox the store is in.
   */
  salvage?(): Promise<void>
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

export type { PlacedPlugin }

/** The phases a harness reports under. */
export type AgentLogPhase = 'env' | 'broker' | 'harness'

/** Where a harness reports what it does, for whoever runs it to keep or show. */
export type AgentLog = {
  /** One readable line. */
  log(phase: AgentLogPhase, text: string): void
  /** A raw payload, with `show` the line it reads as, or `false` to keep it out of sight. */
  trace(phase: AgentLogPhase, kind: string, data: unknown, show?: string | false): void
}

export interface Harness {
  start(
    sandbox: Sandbox,
    signal: AbortSignal,
    treatments: Treatments,
    log: AgentLog,
  ): Promise<HarnessSession>
}
