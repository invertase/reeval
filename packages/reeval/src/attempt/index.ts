// One attempt's lifecycle, a phase per module: resolve the environment (environment.ts), start
// the session (session.ts), run turns (turns.ts), run checks and the judge (checks.ts, judge.ts),
// tear down, and write the record (record.ts). They share one `Attempt` (state.ts).
import { AttemptDebug, withDebug } from '../debug/attempt.ts'
import { attemptDebugDir } from '../debug/files.ts'
import { getRunContext, type TestHandle } from '../engine/runtime.ts'
import type { HarnessSession } from '../harness/types.ts'
import { attemptId, evalId, evalSlug, relativeFile } from '../ids.ts'
import type { Sandbox } from '../sandbox/index.ts'
import { formatDuration } from '../text.ts'
import type { AttemptContext, EvalFn } from '../types.ts'
import { createChecks } from './checks.ts'
import { contextTaker } from './context.ts'
import { tracePlan } from './debug.ts'
import { prepareEnvironment } from './environment.ts'
import { judgeCaller } from './judge.ts'
import { recordEgress, recordFailure, writeRecord } from './record.ts'
import { startSession } from './session.ts'
import { type AttemptSpec, createAttempt, evalTimer } from './state.ts'
import { turnSender } from './turns.ts'

export type { AttemptSpec } from './state.ts'
export { setupAllowance } from './state.ts'

const TRACE_BUFFER_DEFAULT = 8 * 2 ** 20

export async function runAttempt(spec: AttemptSpec, fn: EvalFn, handle: TestHandle): Promise<void> {
  const ctx = getRunContext()
  const { config, runId } = ctx
  const verbosity = ctx.verbosity ?? 0
  const id = evalId(relativeFile(config.root, handle.file), [...spec.groups, spec.name])
  const debug = new AttemptDebug({
    dir: attemptDebugDir(config.root, runId, id, spec.cell.key, spec.n),
    verbosity,
    traceLimit: config.debug?.traceBufferBytes ?? TRACE_BUFFER_DEFAULT,
    ...(verbosity > 0 ? { emit: handle.debug } : {}),
  })
  return withDebug(debug, () => attemptBody(spec, fn, handle, id, debug))
}

async function attemptBody(
  spec: AttemptSpec,
  fn: EvalFn,
  { signal: testSignal, setMeta, progress, unawaited }: TestHandle,
  id: string,
  debug: AttemptDebug,
): Promise<void> {
  const setupStart = performance.now()
  const ctx = getRunContext()
  const { runId, stagingDir, config } = ctx
  tracePlan(debug, spec, ctx)
  // The environment and image are prepared on the test's signal; the eval timer starts after.
  const a = createAttempt(spec, testSignal, progress)
  let timer: AbortSignal | undefined
  let clock: ReturnType<typeof evalTimer> | undefined
  const destroy = () => void a.sandbox?.destroy()
  testSignal.addEventListener('abort', destroy, { once: true })

  // One start, whether c.sandbox() or the first c.send() asks first, or both at once.
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

  const c: AttemptContext = {
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
    await a.timed('setupMs', () => prepareEnvironment(a, config.root, runId, where, testSignal))
    clock = evalTimer(spec.timeoutMs)
    timer = clock.signal
    a.signal = AbortSignal.any([testSignal, timer])
    timer.addEventListener('abort', destroy, { once: true })
    await fn(c)
    // A body that ignores the signal can still return normally after a timeout or cancel.
    a.signal.throwIfAborted()
    const missed = await unawaited()
    if (missed) throw missed
  } catch (error) {
    recordFailure(a, error, timedOut())
    if (timedOut()) throw new Error(`Eval timed out after ${spec.timeoutMs / 1000}s`)
    throw error
  } finally {
    // Checks the eval didn't await still use the sandbox: let them finish before teardown.
    if (!a.signal.aborted) await unawaited().catch(() => {})
    clock?.clear()
    const { sandbox } = a
    if (sandbox && !a.signal.aborted) await takeContext(sandbox, AbortSignal.timeout(30_000))
    if (sandbox) a.report({ kind: 'cleanup' })
    testSignal.removeEventListener('abort', destroy)
    const teardown = performance.now()
    await a.session?.close().catch(() => {})
    if (a.session) debug.log('teardown', 'harness session closed')
    recordEgress(a, sandbox)
    await sandbox?.destroy()
    if (sandbox) {
      debug.log(
        'teardown',
        `sandbox destroyed (${formatDuration(performance.now() - teardown)} for teardown)`,
      )
    }
    const { record } = a
    const error = record.error ? ` · ${record.error.kind}: ${record.error.message}` : ''
    debug.log('teardown', `outcome ${record.outcome}${error}`)
    const rel = (path: string) => relativeFile(config.root, path) || '.'
    const scratch = `.reeval/runs/${runId}`
    debug.log(
      'teardown',
      `record ${scratch}.json · artifacts ${scratch}/${evalSlug(id)}/${evalSlug(spec.cell.key)}/${spec.n} · debug ${rel(debug.dir)}`,
    )
    setMeta(await writeRecord(a, stagingDir, id))
    await debug.finish(debug.verbosity === 2 || record.outcome !== 'pass')
  }
}
