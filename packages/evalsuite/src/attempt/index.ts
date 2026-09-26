// One attempt's lifecycle, a phase per module: resolve the environment (environment.ts), start
// the session (session.ts), run turns (turns.ts), run checks and the judge (checks.ts, judge.ts),
// tear down, and write the record (record.ts). They share one `Attempt` (state.ts).
import { getRunContext, type TestHandle } from '../engine/runtime.ts'
import type { HarnessSession } from '../harness/types.ts'
import { attemptId, evalId, relativeFile } from '../ids.ts'
import type { Sandbox } from '../sandbox/index.ts'
import type { EvalContext, EvalFn } from '../types.ts'
import { createChecks } from './checks.ts'
import { contextTaker } from './context.ts'
import { prepareEnvironment } from './environment.ts'
import { judgeCaller } from './judge.ts'
import { recordEgress, recordFailure, writeRecord } from './record.ts'
import { startSession } from './session.ts'
import { type AttemptSpec, createAttempt, evalTimer } from './state.ts'
import { turnSender } from './turns.ts'

export type { AttemptSpec } from './state.ts'
export { setupAllowance } from './state.ts'

export async function runAttempt(
  spec: AttemptSpec,
  fn: EvalFn,
  { file, signal: testSignal, setMeta, progress }: TestHandle,
): Promise<void> {
  const setupStart = performance.now()
  const { runId, stagingDir, config } = getRunContext()
  const id = evalId(relativeFile(config.root, file), [...spec.groups, spec.name])
  // The environment and image are prepared on the test's signal; the eval timer starts after.
  const a = createAttempt(spec, testSignal, progress)
  let timer: AbortSignal | undefined
  let clock: ReturnType<typeof evalTimer> | undefined
  const destroy = () => void a.sandbox?.destroy()
  testSignal.addEventListener('abort', destroy, { once: true })

  // One start, whether t.sandbox() or the first t.send() asks first, or both at once.
  let starting: Promise<[Sandbox, HarnessSession]> | undefined
  const start = () => {
    starting ??= (async () => {
      clock?.pause()
      try {
        return await a.timed('setupMs', () => startSession(a, runId, setupStart))
      } finally {
        clock?.resume()
      }
    })()
    return starting
  }
  const takeContext = contextTaker(a)
  const { exec, readFile } = createChecks(a)

  const t: EvalContext = {
    get signal() {
      return a.signal
    },
    turns: a.turns,
    exec,
    readFile,
    attempt: { id: attemptId(spec.cell.key, spec.n), cell: spec.cell, n: spec.n },
    async sandbox() {
      await start()
      return { exec, readFile }
    },
    send: turnSender(a, start, takeContext, { exec, readFile }),
    judge: judgeCaller(a),
  }

  const timedOut = () => !!timer?.aborted && !testSignal.aborted
  try {
    a.report({ kind: 'sandbox' })
    const where = `${id} [${attemptId(spec.cell.key, spec.n)}]`
    await a.timed('setupMs', () => prepareEnvironment(a, config.root, where, testSignal))
    clock = evalTimer(spec.timeoutMs)
    timer = clock.signal
    a.signal = AbortSignal.any([testSignal, timer])
    timer.addEventListener('abort', destroy, { once: true })
    await fn(t)
    // A body that ignores the signal can still return normally after a timeout or cancel.
    a.signal.throwIfAborted()
  } catch (error) {
    recordFailure(a, error, timedOut())
    if (timedOut()) throw new Error(`Eval timed out after ${spec.timeoutMs / 1000}s`)
    throw error
  } finally {
    clock?.clear()
    const { sandbox } = a
    if (sandbox && !a.signal.aborted) await takeContext(sandbox, AbortSignal.timeout(30_000))
    if (sandbox) a.report({ kind: 'cleanup' })
    testSignal.removeEventListener('abort', destroy)
    await a.session?.close().catch(() => {})
    recordEgress(a, sandbox)
    await sandbox?.destroy()
    setMeta(await writeRecord(a, stagingDir, id))
  }
}
