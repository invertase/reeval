// Runs one eval file's collected attempts in its worker, all at once: each waits for the
// scheduler's lease, then runs on its own timer, with its console output and assertions routed
// to it through async context.
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { format } from 'node:util'
import { processError } from '@vitest/utils/error'
import { TimeoutError } from '../errors.ts'
import { acquire, type Lease } from '../scheduler/client.ts'
import type { EvalMeta } from '../types.ts'
import type { Progress } from '../ui/events.ts'
import type { DebugLine } from '../view/debug.ts'
import { budgetMarker } from './budget.ts'
import type { CollectedTest } from './collector.ts'
import type { SerializedError } from './errors.ts'
import {
  attemptExpectError,
  createExpect,
  type ExpectTask,
  type Pending,
  rawAssertions,
  unawaitedError,
  withAttemptExpect,
} from './expect.ts'
import { originalStack } from './loader.ts'
import type { WireResult } from './protocol.ts'

/** Where a running file's events go (the IPC channel, in a worker). */
export type Reporter = {
  start(index: number, at: number): void
  progress(index: number, progress: Progress): void
  debug(index: number, line: DebugLine): void
  log(index: number | undefined, at: number, stream: 'stdout' | 'stderr', text: string): void
  result(index: number, result: WireResult): void
  meta(index: number, meta: EvalMeta): void
}

/** An error as it crosses to the main process: its diff computed, then plain data. */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error && typeof error.stack === 'string') {
    try {
      error.stack = originalStack(error.stack)
    } catch {}
  }
  return processError(error) as SerializedError
}

const CONSOLE = {
  log: 'stdout',
  info: 'stdout',
  debug: 'stdout',
  warn: 'stderr',
  error: 'stderr',
} as const

const currentAttempt = new AsyncLocalStorage<number>()

/** Sends console output to the attempt that wrote it, or to the file when no attempt did. */
export function routeConsole(reporter: Reporter): void {
  const target = globalThis.console
  for (const [method, stream] of Object.entries(CONSOLE) as [
    keyof typeof CONSOLE,
    'stdout' | 'stderr',
  ][]) {
    target[method] = (...args: unknown[]) =>
      reporter.log(currentAttempt.getStore(), Date.now(), stream, `${format(...args)}\n`)
  }
}

export type RunOptions = {
  file: string
  stagingDir: string
  /** Aborts every attempt: the run was canceled. */
  signal: AbortSignal
  reporter: Reporter
  /** Called once every attempt that runs has asked for its lease. */
  onReady: () => void
}

/**
 * Runs the tests in `select` whose mode is `run`, and reports the others as skipped. Resolves
 * when every attempt has finished, its cleanup included (a timed-out attempt reports its result
 * at the timeout, then keeps its lease until its sandbox is gone).
 */
export async function runTests(
  tests: CollectedTest[],
  select: ReadonlySet<number>,
  options: RunOptions,
): Promise<void> {
  const settled: Promise<unknown>[] = []
  const bodies = new Set<Promise<void>>()
  for (const test of tests) {
    if (!select.has(test.index) || test.mode !== 'run') {
      options.reporter.result(test.index, { state: 'skipped', errors: [], durationMs: 0 })
      continue
    }
    settled.push(runTest(test, options, bodies))
  }
  options.onReady()
  await Promise.all(settled)
  await Promise.allSettled(bodies)
}

async function runTest(
  test: CollectedTest,
  { file, stagingDir, signal, reporter }: RunOptions,
  bodies: Set<Promise<void>>,
): Promise<void> {
  const { index, options } = test
  const calledAt = Date.now()
  const skip = () =>
    reporter.result(index, { state: 'skipped', errors: [], durationMs: Date.now() - calledAt })
  if (signal.aborted) return skip()
  let lease: Lease | undefined
  if (options.gate) {
    const { limits, rank } = options.gate
    try {
      lease = await acquire(limits, { rank, signal })
    } catch (error) {
      if (signal.aborted) return skip()
      return fail(error)
    }
  }
  if (existsSync(budgetMarker(stagingDir))) {
    lease?.release()
    return skip()
  }
  const startedAt = Date.now()
  reporter.start(index, startedAt)
  const task: ExpectTask = {
    type: 'test',
    name: test.name,
    fullTestName: [...test.groups, test.name].join(' > '),
    file,
  }
  const own = createExpect(task)
  const pending: Pending[] = []
  const timeout = new AbortController()
  let reported = false
  let meta: EvalMeta | undefined
  const body = currentAttempt.run(index, () =>
    withAttemptExpect(own, pending, () =>
      test.body({
        file,
        signal: AbortSignal.any([signal, timeout.signal]),
        setMeta: (next) => {
          meta = next
          if (reported) reporter.meta(index, next)
        },
        progress: (progress) => reporter.progress(index, progress),
        debug: (line) => reporter.debug(index, line),
        unawaited: () => unawaitedError(pending, file),
        expectError: () => attemptExpectError(own),
        assertions: () => rawAssertions(task),
      }),
    ),
  )
  bodies.add(body)
  const release = () => lease?.release()
  body.then(release, release)
  try {
    await (options.timeout ? withTimeout(body, options.timeout, timeout) : body)
    finish({ state: 'passed', errors: [] })
  } catch (error) {
    finish({ state: 'failed', errors: [serializeError(error)] })
  }

  function finish(result: Omit<WireResult, 'durationMs'>) {
    reported = true
    reporter.result(index, {
      ...result,
      durationMs: Date.now() - startedAt,
      ...(meta ? { meta } : {}),
    })
  }

  function fail(error: unknown) {
    reporter.result(index, {
      state: 'failed',
      errors: [serializeError(error)],
      durationMs: Date.now() - calledAt,
    })
  }
}

/** Fails after `ms`, aborting the body; the body keeps its lease until it has cleaned up. */
function withTimeout(running: Promise<void>, ms: number, abort: AbortController): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(`Eval timed out after ${ms / 1000}s`)
      abort.abort(error)
      reject(error)
    }, ms)
  })
  return Promise.race([running, timedOut]).finally(() => clearTimeout(timer))
}
