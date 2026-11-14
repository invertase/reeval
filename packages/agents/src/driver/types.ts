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
   * null when the harness can't time its reasoning, and absent for a scripted harness, whose
   * reasoning events carry their own durations.
   */
  reasoningMs?: number | null
  /**
   * The turn's agent time, recorded in place of the wall clock around `send`; only a scripted
   * harness sets it.
   */
  agentMs?: number
  /** What the harness said the turn cost, when it says. */
  cost?: CostUsd
  /** Every stream part as the harness sent it, only when the driver was asked to keep them. */
  raw?: unknown[]
  /**
   * The tokens of each step the harness reported, in order, which tell the turn's own model
   * calls from its CLI's side calls. Not recorded.
   */
  steps?: TokenUsage[]
  /**
   * The turn's error, naming the variable, when the model API rejected the harness's credential:
   * the run is then an infra error, not the agent's failure.
   */
  rejectedKey?: string
  /** When the model provider, not the agent, ended the turn: the run is then an infra error. */
  providerStop?: ProviderStop
}

/** One agent conversation on one runner. Each `send` is the next turn. */
export interface HarnessSession {
  send(prompt: string, signal: AbortSignal): Promise<HarnessResult>
  /**
   * The running turn as far as it got, for a turn that didn't stop when aborted and that the
   * caller stopped waiting for: what the agent streamed, with `note` (why it stopped waiting)
   * last, and the usage its CLI stored.
   */
  stopped?(note: TranscriptEvent): Promise<HarnessResult>
  /**
   * Reads the usage the running turn's CLI stored so far, for the turn's result: call it when the
   * run is cut off, before the runner the store is in goes away.
   */
  salvage?(): Promise<void>
  close(): Promise<void>
}

/** The phases a harness reports under. */
export type AgentLogPhase = 'env' | 'broker' | 'harness'

/** Where a harness reports what it does, for whoever runs it to keep or show. */
export type AgentLog = {
  /** One readable line. */
  log(phase: AgentLogPhase, text: string): void
  /** A raw payload, with `show` the line it reads as, or `false` to keep it out of sight. */
  trace(phase: AgentLogPhase, kind: string, data: unknown, show?: string | false): void
}
