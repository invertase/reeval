// What `evaluate`, `group` and an attempt use of the engine, whichever engine runs the file:
// the worker's engine installs itself here before it loads an eval file.
import { UsageError } from '../errors.ts'
import type { Limits, Rank } from '../scheduler/core.ts'
import type { AttemptMeta, EvalMeta, RunContext } from '../types.ts'
import type { Progress } from '../ui/events.ts'
import type { DebugLine } from '../view/debug.ts'

import type { RawAssertion } from './expect.ts'

export { attemptRecordings, isUnanswerable, type RawAssertion, SUBJECT } from './expect.ts'

export type TestHandle = {
  file: string
  signal: AbortSignal
  setMeta(meta: EvalMeta): void
  /** Streams a progress event to the main process as it happens. Never throws. */
  progress(progress: Progress): void
  /** Streams a debug line to the main process (for `-v`). Never throws. */
  debug(line: DebugLine): void
  /**
   * Waits for the async assertions the eval started but didn't await, and returns the error that
   * fails the attempt: the first one's failure, or that it wasn't awaited.
   */
  unawaited(): Promise<Error | undefined>
  /** What `expect.assertions` or `expect.hasAssertions` left unmet. */
  expectError(): Error | undefined
  /** The attempt's `expect` and `expect.soft` matcher calls that have settled, in call order. */
  assertions(): RawAssertion[]
}

export type TestMode = 'run' | 'skip' | 'only' | 'todo'

/** What an attempt needs before it starts: leases on these resources, in this place in line. */
export type Gate = { limits: Limits; rank: Rank }

export type TestOptions = {
  /** The attempt's own timeout, from its lease; none for placeholders. */
  timeout?: number
  mode: TestMode
  attempt?: AttemptMeta
  /** The leases the attempt waits for when it's ready to start; none for placeholders. */
  gate?: Gate
}

export type Engine = {
  registerTest(
    name: string,
    options: TestOptions,
    body: (handle: TestHandle) => Promise<void>,
  ): void
  registerGroup(name: string, mode: TestMode, body: () => void): void
  getRunContext(): RunContext
  /** The eval file being collected, while its evals are declared. */
  collectingFile(): string | undefined
}

let engine: Engine | undefined

/** Installs the engine this worker runs eval files with. */
export function useEngine(next: Engine): void {
  engine = next
}

function active(): Engine {
  if (!engine)
    throw new UsageError(
      'evaluate() and group() only work in an eval file that reeval run loads. Run it with reeval run.',
    )
  return engine
}

export const registerTest: Engine['registerTest'] = (name, options, body) =>
  active().registerTest(name, options, body)

export const registerGroup: Engine['registerGroup'] = (name, mode, body) =>
  active().registerGroup(name, mode, body)

export const getRunContext = (): RunContext => active().getRunContext()

export const collectingFile = (): string | undefined => active().collectingFile()
