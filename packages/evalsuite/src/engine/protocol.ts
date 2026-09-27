// Messages between the main process (./pool.ts) and a worker (./worker.ts) over Node's IPC
// channel. A worker may come from another copy of ES (the project's own), so both check
// PROTOCOL before anything else.
import type { Limits, Rank } from '../scheduler/core.ts'
import type { AttemptMeta, EvalMeta, RunContext } from '../types.ts'
import type { Progress } from '../ui/events.ts'
import type { DebugLine } from '../view/debug.ts'
import type { SerializedError } from './errors.ts'

/** Bumped whenever a message changes shape. */
export const PROTOCOL = 1

/** What one registered test looks like to the main process. */
export type WireTest = {
  index: number
  name: string
  groups: string[]
  mode: 'run' | 'skip' | 'only' | 'todo'
  attempt?: AttemptMeta
}

export type WireResult = {
  state: 'passed' | 'failed' | 'skipped'
  errors: SerializedError[]
  durationMs: number
  meta?: EvalMeta
}

export type ToWorker =
  | {
      t: 'init'
      run: RunContext
      file: string
      /** Collect and exit, or run these tests (by index) and exit. */
      select: number[] | null
    }
  | { t: 'grant'; id: string }
  | { t: 'cancel' }

export type FromWorker =
  | { t: 'hello'; protocol: number }
  | { t: 'collected'; tests: WireTest[] }
  | { t: 'load-error'; error: SerializedError }
  | { t: 'request'; id: string; limits: Limits; rank?: Rank }
  | { t: 'release'; id: string }
  /** Every test this worker runs has asked for its lease (or finished without one). */
  | { t: 'ready' }
  | { t: 'start'; index: number; at: number }
  | { t: 'progress'; index: number; progress: Progress }
  | { t: 'debug'; index: number; line: DebugLine }
  | { t: 'log'; index?: number; at: number; stream: 'stdout' | 'stderr'; text: string }
  | { t: 'result'; index: number; result: WireResult }
  /** The attempt wrote its record after its result was sent (after a timeout or cancel). */
  | { t: 'meta'; index: number; meta: EvalMeta }
  | { t: 'unhandled'; error: SerializedError }
  | { t: 'done' }
