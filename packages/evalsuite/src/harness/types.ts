import type { Sandbox } from '../sandbox/types.ts'
import type { TranscriptEvent, TurnStatus } from '../types.ts'

export type HarnessResult = { text: string; status: TurnStatus; transcript: TranscriptEvent[] }

/** One agent conversation in one sandbox. Each `send` is the next turn. */
export interface HarnessSession {
  send(prompt: string, signal: AbortSignal): Promise<HarnessResult>
  close(): Promise<void>
}

export interface Harness {
  start(sandbox: Sandbox, signal: AbortSignal): Promise<HarnessSession>
}
