// Worker-side half of the engine adapter. Together with ./node.ts, this is the only
// code allowed to import `vitest`.
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { afterAll, describe, inject, recordArtifact, test, expect as vitestExpect } from 'vitest'
import { acquire, type Lease, useScheduler } from '../scheduler/client.ts'
import type { Limits, Rank } from '../scheduler/core.ts'
import type { SchedulerAddress } from '../scheduler/protocol.ts'
import type { AttemptMeta, EvalMeta, RunContext } from '../types.ts'
import type { Progress } from '../ui/events.ts'
import { cancelMarker } from './cancel.ts'

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
    toPass(): void
  }
  interface TestArtifactRegistry {
    'es:record': { type: 'es:record'; attachments: { path: string; contentType: string }[] }
    'es:progress': { type: 'es:progress'; progress: Progress }
    'es:start': { type: 'es:start'; at: number }
  }
}

// Attempts run concurrently in one worker, so an assertion must reach the attempt that made it:
// Vitest's global `expect` records async assertions on whichever test started last.
const currentExpect = new AsyncLocalStorage<typeof vitestExpect>()

export const expect: typeof vitestExpect = new Proxy(vitestExpect, {
  apply: (target, thisArg, args) =>
    Reflect.apply(currentExpect.getStore() ?? target, thisArg, args),
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
  attachRecord(path: string): Promise<void>
  /** Streams a progress event to the main process as it happens. Never throws. */
  progress(progress: Progress): void
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
    if (existsSync(cancelMarker(inject('es:run').resultsDir))) {
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
    const startedAt = Date.now()
    recordArtifact(ctx.task, { type: 'es:start', at: startedAt }).catch(() => {})
    const timeout = new AbortController()
    const running = currentExpect.run(ctx.expect, () =>
      body({
        file: ctx.task.file.filepath,
        signal: AbortSignal.any([ctx.signal, timeout.signal]),
        setMeta: (meta) => {
          ctx.task.meta.es = meta
        },
        attachRecord: async (path) => {
          await recordArtifact(ctx.task, {
            type: 'es:record',
            attachments: [{ path, contentType: 'application/json' }],
          })
        },
        progress: (progress) => {
          recordArtifact(ctx.task, { type: 'es:progress', progress }).catch(() => {})
        },
      }),
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
  if (mode === 'todo') describe.todo(name)
  else (mode === 'run' ? describe : describe[mode])(name, body)
}

export const getRunContext = (): RunContext => inject('es:run')

type MatcherResult = { pass: boolean; message: () => string }
export type Matchers = Record<
  string,
  (actual: unknown, ...args: never[]) => MatcherResult | Promise<MatcherResult>
>

export function extendExpect(matchers: Matchers): void {
  vitestExpect.extend(matchers as Parameters<typeof vitestExpect.extend>[0])
}
