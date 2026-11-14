// What a session writes to its `out` directory. Each shape has a JSON Schema snapshot in schema/,
// which only changes additively: a new field is optional.
import type { AgentKind } from '../catalog/entry.ts'
import type { HarnessResult } from '../driver/types.ts'
import type { RunnerInfo } from '../runner.ts'
import type { TranscriptEvent } from '../types.ts'

/** `session.json`: the session as a whole, rewritten as it starts and as it ends. */
export type OutSession = {
  schemaVersion: 1
  /** The `@reeval/agents` version that wrote it. */
  agentsVersion: string
  harness: { kind: AgentKind; model: string; effort?: string }
  /** The AI SDK adapter that drove the harness: its `harnessId`; absent when none was built. */
  adapter?: { name: string }
  /** Where the agent's CLI ran; absent when the session failed before the runner answered. */
  runner?: RunnerInfo
  startedAt: string
  /** Absent while the session is open. */
  endedAt?: string
  /** Milliseconds each start-up phase took, for the phases it reached. */
  phases: { runner?: number; place?: number; install?: number; bootstrap?: number }
  /** `running` while open, `closed` once closed, `failed` when it failed to start. */
  status: 'running' | 'closed' | 'failed'
  /** Why it failed to start. */
  error?: string
}

/** One line of `turns.jsonl`: a turn's result, less its transcript, raw parts and steps. */
export type OutTurn = Omit<HarnessResult, 'transcript' | 'raw' | 'steps'> & {
  /** The turn's index in the session, from 0. */
  turn: number
  /** What the turn was sent. */
  prompt: string
}

/**
 * One line of `transcript.jsonl`: a transcript event and its turn. A tool's output past 128K
 * characters is cut to its head and tail, with `outputTruncated` its whole size in bytes.
 */
export type OutTranscriptLine = TranscriptEvent & {
  /** The turn's index in the session, from 0. */
  turn: number
}
