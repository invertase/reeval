// The terminal output's view of a run. Nothing in ui/ may import Vitest: the engine translates
// its reporter hooks into these events.
import type { RunRecord } from '../history/types.ts'
import type { EvalMeta, TurnStatus } from '../types.ts'

export type EvalResult = {
  id: string
  file: string
  /** Enclosing group names, outermost first. */
  group: string[]
  name: string
  state: 'passed' | 'failed' | 'skipped'
  durationMs: number
  errors: string[]
  /** `errors` as Vitest prints them (diff, code frame), with ANSI colour codes. */
  formattedErrors: string[]
  meta: EvalMeta | undefined
}

/** What the worker reports while an eval runs. */
export type ProgressUpdate =
  | { kind: 'sandbox' }
  | { kind: 'sandbox-ready'; ms: number }
  | { kind: 'turn-start'; turn: number }
  | {
      kind: 'turn-end'
      turn: number
      status: TurnStatus
      ms: number
      tools: number
      fileEdits: number
    }
  | { kind: 'check-start'; command: string }
  | { kind: 'check-end'; command: string; exitCode: number; ms: number }
  | { kind: 'judge-start'; question: string }
  | {
      kind: 'judge-end'
      question: string
      verdict: 'pass' | 'fail' | 'error'
      score: number | null
      threshold: number | null
      ms: number
    }
  | { kind: 'cleanup' }

/** A progress update stamped with the worker's clock (epoch ms). */
export type Progress = { at: number } & ProgressUpdate

export type CollectedEval = { id: string; group: string[]; name: string; skipped: boolean }

export type EsEvent =
  | {
      type: 'run-start'
      at: number
      version: string
      files: number
      harness: string
      sandbox: string
    }
  /** Every eval in a file, once the file is collected (skipped ones included, for stable tags). */
  | { type: 'collected'; at: number; file: string; evals: CollectedEval[] }
  | { type: 'eval-start'; at: number; id: string; attempt: number }
  | { type: 'eval-progress'; id: string; attempt: number; progress: Progress }
  /** User `console.log`/`console.error` output; `id` is unset for output outside an eval. */
  | {
      type: 'log'
      at: number
      id?: string
      attempt?: number
      stream: 'stdout' | 'stderr'
      text: string
    }
  | { type: 'eval-end'; at: number; attempt: number; result: EvalResult }
  /** A run-level message, e.g. the Ctrl-C notice. */
  | { type: 'notice'; at: number; level: 'info' | 'warn' | 'error'; text: string }
  | {
      type: 'run-end'
      at: number
      record: RunRecord
      /** summary.md, or the record itself when there are no artifacts. */
      summaryPath: string
      /** The engine's results, for Vitest-formatted failure details. */
      results: EvalResult[]
      unhandledErrors: string[]
    }

export interface Renderer {
  onEvent(event: EsEvent): void
  close(): void
}

/** Where output goes; `process.stdout` in the CLI, a capture in tests. */
export type OutputStream = { write(text: string): unknown }
