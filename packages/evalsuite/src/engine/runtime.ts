// Worker-side half of the engine adapter. Together with ./node.ts, this is the only
// code allowed to import `vitest`.
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readFileSync } from 'node:fs'
import { format } from 'node:util'
import {
  afterAll,
  describe,
  inject,
  recordArtifact,
  TestRunner,
  test,
  expect as vitestExpect,
} from 'vitest'
import { acquire, type Lease, useScheduler } from '../scheduler/client.ts'
import type { Limits, Rank } from '../scheduler/core.ts'
import type { SchedulerAddress } from '../scheduler/protocol.ts'
import type { AttemptMeta, EvalMeta, RunContext } from '../types.ts'
import type { Progress } from '../ui/events.ts'
import type { DebugLine } from '../view/debug.ts'
import { budgetMarker, cancelMarker } from './cancel.ts'

declare module 'vitest' {
  interface ProvidedContext {
    'es:run': RunContext
    'es:scheduler': SchedulerAddress | undefined
  }
  interface TaskMeta {
    es?: EvalMeta
    esAttempt?: AttemptMeta
    /** From the attempt's start (its lease) to its end, without time spent queued. */
    esRunMs?: number
  }
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toHaveFile(path: string, pattern?: RegExp | string): Promise<void>
    toSucceed(): Promise<void>
    toHaveSearched(query?: RegExp | string): void
    toHaveFetched(url?: RegExp | string): void
    toPass(): void
  }
  interface TestArtifactRegistry {
    'es:progress': { type: 'es:progress'; progress: Progress }
    'es:start': { type: 'es:start'; at: number }
    'es:debug': { type: 'es:debug'; line: DebugLine }
    'es:log': { type: 'es:log'; at: number; stream: 'stdout' | 'stderr'; text: string }
  }
}

// Attempts run concurrently in one worker, so an assertion must reach the attempt that made it:
// Vitest's global `expect` records async assertions on whichever test started last.
const currentExpect = new AsyncLocalStorage<typeof vitestExpect>()

// Vitest also tags console output with whichever test started last, so a line an eval logs
// reaches the attempt through its async context instead. The attempt waits for its lines to
// arrive before it ends, so none land after its result.
type Logging = { task: Parameters<typeof recordArtifact>[0]; sent: Set<Promise<unknown>> }
const currentTask = new AsyncLocalStorage<Logging>()
const CONSOLE = {
  log: 'stdout',
  info: 'stdout',
  debug: 'stdout',
  warn: 'stderr',
  error: 'stderr',
} as const
let consoleRouted = false

function routeConsole(): void {
  if (consoleRouted) return
  consoleRouted = true
  const target = globalThis.console
  for (const [method, stream] of Object.entries(CONSOLE) as [
    keyof typeof CONSOLE,
    'stdout' | 'stderr',
  ][]) {
    const original = target[method].bind(target)
    target[method] = (...args: unknown[]) => {
      const logging = currentTask.getStore()
      if (!logging) return original(...args)
      const text = `${format(...args)}\n`
      const sent = recordArtifact(logging.task, { type: 'es:log', at: Date.now(), stream, text })
        .catch(() => original(...args))
        .finally(() => logging.sent.delete(sent))
      logging.sent.add(sent)
    }
  }
}

/** An async assertion (`toHaveFile`, `toSucceed`, `.resolves`…) and whether the eval awaited it. */
type Pending = { assertion: string; settled: Promise<unknown>; observed: boolean }
const currentPending = new AsyncLocalStorage<Pending[]>()

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Promise<unknown>).then === 'function'

/**
 * Wraps an assertion chain so each promise one of its matchers returns is tracked: an eval that
 * doesn't await it would otherwise pass and tear its sandbox down while the check still runs.
 */
function tracked<T extends object>(assertion: T, pending: Pending[], path: string): T {
  return new Proxy(assertion, {
    get(target, property) {
      const value = Reflect.get(target, property)
      const name = `${path}.${String(property)}`
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args)
          if (!isThenable(result)) return result
          const entry: Pending = {
            assertion: `${name}()`,
            settled: Promise.resolve(result).then(
              () => undefined,
              (error: unknown) => error ?? new Error(`${name}() failed`),
            ),
            observed: false,
          }
          pending.push(entry)
          const observe = <R>(fn: (p: Promise<unknown>) => R) => {
            entry.observed = true
            return fn(Promise.resolve(result))
          }
          return {
            // biome-ignore lint/suspicious/noThenProperty: a thenable that knows it was awaited
            then: (onFulfilled?: never, onRejected?: never) =>
              observe((p) => p.then(onFulfilled, onRejected)),
            catch: (onRejected?: never) => observe((p) => p.catch(onRejected)),
            finally: (onFinally?: never) => observe((p) => p.finally(onFinally)),
            [Symbol.toStringTag]: 'Promise',
          }
        }
      }
      return typeof value === 'object' && value !== null && !isThenable(value)
        ? tracked(value, pending, name)
        : value
    },
  })
}

export const expect: typeof vitestExpect = new Proxy(vitestExpect, {
  apply: (target, thisArg, args) => {
    const assertion = Reflect.apply(currentExpect.getStore() ?? target, thisArg, args)
    const pending = currentPending.getStore()
    return pending && typeof assertion === 'object' && assertion !== null
      ? tracked(assertion, pending, 'expect(…)')
      : assertion
  },
  get: (target, property) => {
    const bound = currentExpect.getStore() ?? target
    const value = Reflect.get(bound, property)
    // Not `bind`: it reads `length`, which Chai's proxied methods reject.
    return typeof value === 'function'
      ? (...args: unknown[]) => Reflect.apply(value, bound, args)
      : value
  },
})

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
}

export type TestMode = 'run' | 'skip' | 'only' | 'todo'

/** What an attempt needs before it starts: leases on these resources, in this place in line. */
export type Gate = { limits: Limits; rank: Rank }

/** Connects this worker to the run's scheduler. */
export const connectScheduler = (): void => useScheduler(inject('es:scheduler'))

export function registerTest(
  name: string,
  options: {
    timeout?: number
    mode: TestMode
    attempt?: AttemptMeta
    /** Called with the eval file's path when the attempt is ready to start. */
    gate?: (file: string) => Gate
  },
  body: (handle: TestHandle) => Promise<void>,
): void {
  const meta = options.attempt ? { esAttempt: options.attempt } : {}
  if (options.mode === 'todo') {
    test(name, { todo: true, meta }, () => {})
    return
  }
  const register = options.mode === 'run' ? test : test[options.mode]
  // Vitest's timer would count time spent queued, so the attempt's own timer starts at its lease.
  register(name, { timeout: 0, retry: 0, meta }, async (ctx) => {
    if (existsSync(cancelMarker(inject('es:run').stagingDir))) {
      ctx.skip('The run was cancelled before this attempt started')
    }
    let lease: Lease | undefined
    if (options.gate) {
      const { limits, rank } = options.gate(ctx.task.file.filepath)
      try {
        lease = await acquire(limits, { rank, signal: ctx.signal })
      } catch (error) {
        if (ctx.signal.aborted) ctx.skip('The run was cancelled before this attempt started')
        throw error
      }
    }
    const budget = budgetMarker(inject('es:run').stagingDir)
    if (existsSync(budget)) {
      lease?.release()
      ctx.skip(
        readFileSync(budget, 'utf8') || 'The run reached its budget before this attempt started',
      )
    }
    const startedAt = Date.now()
    recordArtifact(ctx.task, { type: 'es:start', at: startedAt }).catch(() => {})
    const timeout = new AbortController()
    const pending: Pending[] = []
    routeConsole()
    const logging: Logging = { task: ctx.task, sent: new Set() }
    const running = currentTask.run(logging, () =>
      currentExpect.run(ctx.expect, () =>
        currentPending.run(pending, () =>
          body({
            file: ctx.task.file.filepath,
            signal: AbortSignal.any([ctx.signal, timeout.signal]),
            setMeta: (meta) => {
              ctx.task.meta.es = meta
            },
            progress: (progress) => {
              recordArtifact(ctx.task, { type: 'es:progress', progress }).catch(() => {})
            },
            debug: (line) => {
              recordArtifact(ctx.task, { type: 'es:debug', line }).catch(() => {})
            },
            unawaited: () => unawaitedError(pending),
          }),
        ),
      ),
    )
    inFlight.add(running)
    const settle = () => {
      inFlight.delete(running)
      lease?.release()
    }
    running.then(settle, settle)
    try {
      await (options.timeout ? withTimeout(running, options.timeout, timeout) : running)
    } finally {
      ctx.task.meta.esRunMs = Date.now() - startedAt
      await Promise.allSettled(logging.sent)
    }
  })
}

async function unawaitedError(pending: Pending[]): Promise<Error | undefined> {
  const missed = pending.filter((p) => !p.observed)
  if (missed.length === 0) return undefined
  for (const p of missed) p.observed = true
  const outcomes = await Promise.all(missed.map((p) => p.settled))
  const i = Math.max(
    0,
    outcomes.findIndex((o) => o !== undefined),
  )
  const hint = `${missed[i]?.assertion} wasn't awaited. Its check is async: write \`await ${missed[i]?.assertion}\`.`
  const failure = outcomes[i]
  if (failure instanceof Error) {
    failure.message = `${failure.message}\n\n${hint}`
    return failure
  }
  const error = new Error(hint)
  error.name = 'AssertionError'
  return error
}

/** Fails after `ms`, aborting the body; the body keeps its lease until it has cleaned up. */
function withTimeout(running: Promise<void>, ms: number, abort: AbortController): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Eval timed out after ${ms / 1000}s`)
      abort.abort(error)
      reject(error)
    }, ms)
  })
  return Promise.race([running, timedOut]).finally(() => clearTimeout(timer))
}

// On timeout or cancel, the test settles without waiting for its body, and Vitest may stop
// the worker right after the file ends. Holding the file open lets every body finish its
// cleanup (sandbox destroy, record write).
const inFlight = new Set<Promise<void>>()

export function holdFileUntilEvalsSettle(): void {
  afterAll(async () => {
    await Promise.allSettled(inFlight)
  })
}

export function registerGroup(name: string, mode: TestMode, body: () => void): void {
  if (mode === 'todo') describe.todo(name)
  else (mode === 'run' ? describe : describe[mode])(name, body)
}

export const getRunContext = (): RunContext => inject('es:run')

/** The eval file being collected, while its evals are declared. */
export function collectingFile(): string | undefined {
  try {
    return TestRunner.getCurrentSuite()?.file?.filepath
  } catch {
    return undefined
  }
}

type MatcherResult = { pass: boolean; message: () => string }
export type Matchers = Record<
  string,
  (actual: unknown, ...args: never[]) => MatcherResult | Promise<MatcherResult>
>

export function extendExpect(matchers: Matchers): void {
  vitestExpect.extend(matchers as Parameters<typeof vitestExpect.extend>[0])
}
