// One attempt's lifecycle, a phase per module: resolve the environment (environment.ts), start
// the session (session.ts), run turns (turns.ts), run checks and the judge (checks.ts, judge.ts),
// tear down, and write the record (record.ts). They share one `Attempt` (state.ts).
import { AttemptDebug, withDebug } from '../debug/attempt.ts'
import { attemptDebugDir } from '../debug/files.ts'
import { getRunContext, type TestHandle } from '../engine/runtime.ts'
import { TimeoutError } from '../errors.ts'
import { attemptId, attemptKey, evalId, evalSlug, relativeFile } from '../ids.ts'
import { redactSecrets } from '../redact.ts'
import { clip, formatDuration } from '../text.ts'
import type { AttemptContext, EvalFn } from '../types.ts'
import { assertionRecords, checkFailure } from './assertions.ts'
import { capturePage, serveCommand } from './capture.ts'
import { createChecks } from './checks.ts'
import { contextTaker } from './context.ts'
import { tracePlan } from './debug.ts'
import { prepareEnvironment } from './environment.ts'
import { judgeCaller } from './judge.ts'
import { attemptError, recordEgress, recordFailure, recordOom, writeRecord } from './record.ts'
import { startSession } from './session.ts'
import { snapshotSidecar, takeSnapshot } from './snapshot.ts'
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
  { signal: testSignal, setMeta, progress, unawaited, expectError, assertions }: TestHandle,
  id: string,
  debug: AttemptDebug,
): Promise<void> {
  const ctx = getRunContext()
  const { runId, stagingDir, config } = ctx
  tracePlan(debug, spec, ctx)
  let timer: AbortSignal | undefined
  let clock: ReturnType<typeof evalTimer> | undefined
  // The environment and image are prepared on the test's signal; the eval timer starts after,
  // and pauses while the sandbox starts.
  const a = createAttempt(
    spec,
    testSignal,
    progress,
    async (a, who) => {
      debug.log('container', `starting the sandbox and session for ${who}`)
      clock?.pause()
      try {
        return await a.timed('setupMs', () => startSession(a, runId))
      } finally {
        clock?.resume()
      }
    },
    snapshotSidecar(stagingDir, attemptKey(id, spec.cell.key, spec.n)),
  )
  const destroy = () => void a.sandbox?.destroy()
  testSignal.addEventListener('abort', destroy, { once: true })

  const takeContext = contextTaker(a)
  const { exec, readFile, writeFile } = createChecks(a)

  const c: AttemptContext = {
    get signal() {
      return a.signal
    },
    turns: a.turns,
    exec,
    readFile,
    writeFile,
    serve: (command, port) => serveCommand(a, command, port),
    capture: (target, options) => capturePage(a, target, options),
    attempt: { id: attemptId(spec.cell.key, spec.n), cell: spec.cell, n: spec.n },
    send: turnSender(a, takeContext, { exec, readFile }),
    judge: judgeCaller(a, readFile),
  }

  const timedOut = () => !!timer?.aborted && !testSignal.aborted
  let failure: { error: unknown } | undefined
  let oom: Error | undefined
  try {
    a.report({ kind: 'sandbox' })
    const where = `${id} [${attemptId(spec.cell.key, spec.n)}]`
    await a.timed('setupMs', () => prepareEnvironment(a, config.root, runId, where, testSignal))
    clock = evalTimer(spec.timeoutMs)
    timer = clock.signal
    a.signal = AbortSignal.any([testSignal, timer])
    timer.addEventListener('abort', destroy, { once: true })
    await fn(c).catch((error: unknown) => {
      throw a.startFailure ? a.startFailure.error : error
    })
    // A body that ignores the signal can still return normally after a timeout or cancel.
    a.signal.throwIfAborted()
    const missed = (await unawaited()) ?? checkFailure(assertions()) ?? expectError()
    // A start that failed under a caught call or an `expect` still fails the attempt as itself.
    if (a.startFailure) throw a.startFailure.error
    if (missed) throw missed
    const judgeErrors = a.judgeErrors.toSorted((x, y) => x.call - y.call).map((e) => e.message)
    const [only, ...more] = judgeErrors
    if (only) {
      const message = more.length
        ? `${more.length + 1} judge calls failed:\n${judgeErrors.join('\n')}`
        : only
      a.judgeThrown.add(message)
      throw new Error(message)
    }
  } catch (thrown) {
    const error = attemptError(a, thrown, assertions())
    recordFailure(a, error, timedOut(), assertions())
    failure = {
      error: timedOut()
        ? new TimeoutError(`Eval timed out after ${spec.timeoutMs / 1000}s`)
        : error,
    }
  } finally {
    // Checks the eval didn't await still use the sandbox: let them finish before teardown.
    if (!a.signal.aborted) await unawaited().catch(() => {})
    clock?.clear()
    await a.endStarts()
    for (const bg of a.backgrounds) await bg.kill().catch(() => {})
    const { sandbox } = a
    if (sandbox && !a.signal.aborted) await takeContext(sandbox, AbortSignal.timeout(30_000))
    if (sandbox) a.report({ kind: 'cleanup' })
    testSignal.removeEventListener('abort', destroy)
    const teardown = performance.now()
    await a.session?.close().catch(() => {})
    if (a.session) debug.log('teardown', 'harness session closed')
    recordEgress(a, sandbox)
    // A timeout or cancel has already removed the container, so there's nothing left to read.
    oom = a.signal.aborted ? undefined : await recordOom(a, sandbox)
    if (sandbox && spec.snapshot.when && !a.signal.aborted) {
      await takeSnapshot(a, sandbox, 'final', 'teardown')
    }
    await sandbox?.destroy()
    if (sandbox) {
      debug.log(
        'teardown',
        `sandbox destroyed (${formatDuration(performance.now() - teardown)} for teardown)`,
      )
    }
    const { record } = a
    const checked = assertionRecords(assertions())
    if (checked.length) record.assertions = checked
    for (const x of checked) {
      const why = x.message ? ` · ${clip(redactSecrets(x.message.split('\n')[0] ?? ''), 160)}` : ''
      debug.log(
        'check',
        `assert ${x.status === 'pass' ? '✓' : '✗'} ${x.label} (${x.matcher}, ${x.status})${why}`,
      )
    }
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
  if (oom) throw oom
  if (failure) throw failure.error
}
