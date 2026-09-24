import type { Sandbox } from '../sandbox/types.ts'
import type { TranscriptEvent, TurnStatus } from '../types.ts'

export type HarnessResult = {
  /** The agent's final message for the turn. */
  text: string
  status: TurnStatus
  startedAt: string
  durationMs: number
  transcript: TranscriptEvent[]
  /** Every stream part as the harness sent it, only when `ES_RAW_TRANSCRIPT` is set. */
  raw?: unknown[]
}

/** One agent conversation in one sandbox. Each `send` is the next turn. */
export interface HarnessSession {
  send(prompt: string, signal: AbortSignal): Promise<HarnessResult>
  close(): Promise<void>
}

export interface Harness {
  start(sandbox: Sandbox, signal: AbortSignal): Promise<HarnessSession>
}
