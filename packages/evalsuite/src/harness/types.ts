import type { Sandbox } from '../sandbox/types.ts'
import type { RunStatus, TranscriptEvent } from '../types.ts'

export type HarnessResult = { text: string; status: RunStatus; transcript: TranscriptEvent[] }

export interface Harness {
  run(sandbox: Sandbox, prompt: string, signal: AbortSignal): Promise<HarnessResult>
}
