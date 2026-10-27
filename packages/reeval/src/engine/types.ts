// What the engine hands the CLI: the plan it collected and each attempt's result.
import type { AttemptMeta, RunContext } from '../types.ts'
import type { EvalResult, ReevalEvent } from '../ui/events.ts'

/** One attempt's result. */
export type EngineEval = EvalResult

export type EngineRun = {
  evals: EngineEval[]
  unhandledErrors: string[]
  canceled: boolean
  noFiles: boolean
  /** `onPlan` said not to run, e.g. for `--dry-run`. */
  stopped: boolean
}

/** One planned attempt, from collecting the eval files without running them. */
export type PlannedItem = { id: string; key: string; file: string; attempt: AttemptMeta }

/** An eval collection left out: `.skip`, `.todo`, or a sibling of an `.only`. */
export type ExcludedEval = { id: string; mode: 'skip' | 'todo' }

/**
 * What a run would start, from collecting the eval files; `matched` counts filter hits, and
 * `unmatched` lists the name or cell filter parts that matched no eval while others did.
 */
export type CollectedPlan = {
  planned: PlannedItem[]
  excluded: ExcludedEval[]
  matched: number
  unmatched: string[]
  /** The harness ids the collected files' evals run on before a profile's limit, whatever the filters pick. */
  harnesses: string[]
  /** A path filter left some eval files uncollected. */
  partial: boolean
}

export type EngineOptions = {
  run: RunContext
  filters: string[]
  /** Called once the eval files are known, with how many there are. */
  onRunStart?: (files: number) => void
  /** Collection, start, progress, console output and result of each attempt, as they happen. */
  onEvent?: (e: ReevalEvent) => void
  /** Called once the engine can be canceled, with a function that cancels the run. */
  onCancelable?: (cancel: () => void) => void
  /**
   * Called with every attempt the run would start, after collecting the files and before any
   * attempt runs. Resolve false to stop there; throw to fail the run.
   */
  onPlan?: (collected: CollectedPlan) => Promise<boolean>
}
