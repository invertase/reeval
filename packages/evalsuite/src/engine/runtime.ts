// Worker-side half of the engine adapter. Together with ./node.ts, this is the only
// code allowed to import `vitest`.
import { afterAll, describe, expect, inject, recordArtifact, test } from 'vitest'
import type { EvalMeta, RunContext } from '../types.ts'

declare module 'vitest' {
  interface ProvidedContext {
    'es:run': RunContext
  }
  interface TaskMeta {
    es?: EvalMeta
  }
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toHaveFile(path: string, pattern?: RegExp | string): Promise<void>
    toSucceed(): Promise<void>
    toPass(): void
  }
  interface TestArtifactRegistry {
    'es:record': { type: 'es:record'; attachments: { path: string; contentType: string }[] }
  }
}

export { expect }

export type TestHandle = {
  file: string
  signal: AbortSignal
  setMeta(meta: EvalMeta): void
  attachRecord(path: string): Promise<void>
}

export type TestMode = 'run' | 'skip' | 'only'

export function registerTest(
  name: string,
  options: { timeout?: number; mode: TestMode },
  body: (handle: TestHandle) => Promise<void>,
): void {
  const register = options.mode === 'run' ? test : test[options.mode]
  register(name, { timeout: options.timeout, retry: 0 }, async (ctx) => {
    const running = body({
      file: ctx.task.file.filepath,
      signal: ctx.signal,
      setMeta: (meta) => {
        ctx.task.meta.es = meta
      },
      attachRecord: async (path) => {
        await recordArtifact(ctx.task, {
          type: 'es:record',
          attachments: [{ path, contentType: 'application/json' }],
        })
      },
    })
    inFlight.add(running)
    running.then(
      () => inFlight.delete(running),
      () => inFlight.delete(running),
    )
    await running
  })
}

// On timeout or cancel, Vitest settles the test without waiting for its body, and may stop
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

type MatcherResult = { pass: boolean; message: () => string }
export type Matchers = Record<
  string,
  (actual: unknown, ...args: never[]) => MatcherResult | Promise<MatcherResult>
>

export function extendExpect(matchers: Matchers): void {
  expect.extend(matchers as Parameters<typeof expect.extend>[0])
}
