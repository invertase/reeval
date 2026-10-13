// The terminal output's view of a run. Nothing in ui/ may import Vitest: the engine translates
// its reporter hooks into these events.
import type { RunRecord } from '../history/types.ts'
import type { PrepareEvent } from '../sandbox/preflight.ts'
import type { AttemptMeta, EvalMeta, SandboxWarning, TurnStatus } from '../types.ts'
import type { DebugLine } from '../view/debug.ts'

/** One attempt's result. `id` is the eval's; `key` is unique per attempt. */
export type EvalResult = {
  id: string
  key: string
  file: string
  /** Enclosing group names, outermost first. */
  group: string[]
  name: string
  /** Absent when the engine did not register an attempt for this result. */
  attempt: AttemptMeta | undefined
  state: 'passed' | 'failed' | 'skipped'
  durationMs: number
  errors: string[]
  /** The first error's `name` (`TimeoutError`, `AbortError`), when the worker sent one. */
  errorName?: string
  /** `errors` as Vitest prints them (diff, code frame), with ANSI colour codes. */
  formattedErrors: string[]
  meta: EvalMeta | undefined
  /** A placeholder (`evaluate.todo` or `group.todo`): no body; it's skipped and shown as todo. */
  todo?: true
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
      /** The turn's first error event, e.g. the provider's billing or auth error. */
      error?: string
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
  | {
      kind: 'browser-download'
      name: string
      version: string
      bytes: number | null
      received: number
      cache: string
    }

/** A progress update stamped with the worker's clock (epoch ms). */
export type Progress = { at: number } & ProgressUpdate

/** One collected attempt. */
export type CollectedEval = {
  id: string
  key: string
  group: string[]
  name: string
  skipped: boolean
}

/** What a line about an attempt needs to name it. */
export type AttemptRef = { id: string; key: string; attempt: AttemptMeta | undefined }

export type EsEvent =
  | {
      type: 'run-start'
      at: number
      version: string
      files: number
      harness: string
      sandbox: string
      /** How many attempts run at once. */
      concurrency: number
      runId: string
    }
  /**
   * The plan line (and, for `--dry-run`, its table), its warnings and hints, before anything runs;
   * then each sandbox that runs as root or with capabilities added back.
   */
  | { type: 'plan'; at: number; lines: string[]; sandboxWarnings?: SandboxWarning[] }
  /** Every attempt in a file, once it's collected (skipped ones too, so tags are stable). */
  | { type: 'collected'; at: number; file: string; evals: CollectedEval[] }
  | ({ type: 'eval-start'; at: number } & AttemptRef)
  | { type: 'eval-progress'; key: string; progress: Progress }
  /** A `-v` (level 1) or `-vv` (level 2) debug line from an attempt, as it happens. */
  | { type: 'debug'; key: string; line: DebugLine }
  /** User `console.log`/`console.error` output; `key` is unset for output outside an eval. */
  | { type: 'log'; at: number; key?: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'eval-end'; at: number; result: EvalResult }
  /** Preflight preparing the sandboxes: the list, then each one ready or failed. */
  | ({ type: 'prepare'; at: number } & PrepareEvent)
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
