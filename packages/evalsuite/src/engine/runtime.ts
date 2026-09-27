// Worker-side half of the engine adapter. Together with ./node.ts, this is the only
// code allowed to import `vitest`.
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readFileSync } from 'node:fs'
import { format } from 'node:util'
import { afterAll, describe, inject, recordArtifact, TestRunner, test } from 'vitest'
import { acquire, type Lease, useScheduler } from '../scheduler/client.ts'
import type { Limits, Rank } from '../scheduler/core.ts'
import type { SchedulerAddress } from '../scheduler/protocol.ts'
import type { AttemptMeta, EvalMeta, RunContext } from '../types.ts'
import type { Progress } from '../ui/events.ts'
import type { DebugLine } from '../view/debug.ts'
import { budgetMarker, cancelMarker } from './cancel.ts'
import {
  attemptExpectError,
  createExpect,
  type ExpectTask,
  type Pending,
  unawaitedError,
  withAttemptExpect,
} from './expect.ts'

export { expect, extendExpect, type Matchers } from './expect.ts'

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
  interface TestArtifactRegistry {
    'es:progress': { type: 'es:progress'; progress: Progress }
    'es:start': { type: 'es:start'; at: number }
    'es:debug': { type: 'es:debug'; line: DebugLine }
    'es:log': { type: 'es:log'; at: number; stream: 'stdout' | 'stderr'; text: string }
  }
}

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
    const task: ExpectTask = { type: 'test', name, fullTestName: ctx.task.fullTestName ?? name }
    const own = createExpect(task)
    routeConsole()
    const logging: Logging = { task: ctx.task, sent: new Set() }
    const running = currentTask.run(logging, () =>
      withAttemptExpect(own, pending, () =>
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
          unawaited: async () => (await unawaitedError(pending)) ?? attemptExpectError(own, task),
        }),
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
  const register = mode === 'run' ? describe : describe[mode]
  register(name, body)
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
