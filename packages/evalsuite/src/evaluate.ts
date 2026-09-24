import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDuration } from './config.ts'
import { diffSinceSnapshot, snapshot } from './diff.ts'
import { getRunContext, registerTest, type TestHandle, type TestMode } from './engine/runtime.ts'
import { createHarness } from './harness/index.ts'
import { evalId, recordFileName, relativeFile } from './ids.ts'
import { runJudge } from './judge/index.ts'
import { createSandbox, InfraError, type Sandbox } from './sandbox/index.ts'
import type {
  Agent,
  Duration,
  ErrorKind,
  EvalFn,
  EvalMeta,
  EvalRecord,
  Judge,
  Run,
} from './types.ts'

type EvalOptions = { timeout?: Duration }

type EvaluateFn = {
  (name: string, fn: EvalFn): void
  (name: string, options: EvalOptions, fn: EvalFn): void
}

const define =
  (mode: TestMode): EvaluateFn =>
  (name: string, optionsOrFn: EvalOptions | EvalFn, maybeFn?: EvalFn) => {
    const [options, fn] =
      typeof optionsOrFn === 'function' ? [{}, optionsOrFn] : [optionsOrFn, maybeFn]
    if (typeof fn !== 'function') throw new TypeError(`evaluate("${name}") needs a function`)
    const timeout = options.timeout === undefined ? undefined : parseDuration(options.timeout)
    registerTest(name, { timeout, mode }, (handle) => runEval(name, timeout, fn, handle))
  }

export const evaluate: EvaluateFn & { skip: EvaluateFn; only: EvaluateFn } = Object.assign(
  define('run'),
  { skip: define('skip'), only: define('only') },
)

function classify(error: unknown, signal: AbortSignal): { kind: ErrorKind; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof InfraError) return { kind: 'infra', message }
  if (signal.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason)
    return /timed out/i.test(reason)
      ? { kind: 'timeout', message: 'The eval timed out' }
      : { kind: 'aborted', message: 'The run was cancelled' }
  }
  return { kind: 'assertion', message }
}

async function runEval(
  name: string,
  timeoutOverride: number | undefined,
  fn: EvalFn,
  { file, signal, setMeta, attachRecord }: TestHandle,
): Promise<void> {
  const { runId, resultsDir, config } = getRunContext()
  const record: EvalRecord = {
    outcome: 'pass',
    error: null,
    agent: null,
    diff: null,
    checks: [],
    judgements: [],
  }
  let sandbox: Sandbox | undefined
  const destroy = () => void sandbox?.destroy()
  signal.addEventListener('abort', destroy, { once: true })

  const agent: Agent = {
    async run(prompt) {
      if (record.agent) throw new Error('agent.run() can only be called once per eval')
      record.agent = { prompt, text: '', status: 'error', transcript: [] }
      const timeoutMs = (timeoutOverride ?? config.timeoutMs) + 60_000
      const box = await createSandbox(config.sandbox, { runId, timeoutMs, signal })
      sandbox = box
      if (signal.aborted) destroy()
      signal.throwIfAborted()
      await snapshot(box, signal)
      const harness = await createHarness(config.harness)
      const result = await harness.run(box, prompt, signal)
      record.agent = { prompt, ...result }
      signal.throwIfAborted()
      const diff = await diffSinceSnapshot(box, signal)
      record.diff = diff
      const run: Run = {
        prompt,
        ...result,
        diff,
        async exec(command) {
          const r = await box.exec(command, { signal })
          record.checks.push({ command, ...r })
          return r
        },
        readFile: (path) => box.readFile(path),
      }
      return run
    },
  }

  const judge: Judge = async (run, question) => {
    const j = await runJudge(config.judge, { ...run, question }, signal)
    record.judgements.push(j)
    return { verdict: j.verdict, reason: j.reason, evidence: j.evidence }
  }

  try {
    await fn({ agent, judge, signal })
  } catch (error) {
    record.error = classify(error, signal)
    const judgeFailed = record.judgements.some((j) => j.verdict !== 'pass')
    if (record.error.kind === 'assertion' && judgeFailed) record.error.kind = 'judge'
    record.outcome = record.error.kind === 'infra' ? 'infra_error' : 'fail'
    throw error
  } finally {
    signal.removeEventListener('abort', destroy)
    await sandbox?.destroy()
    const id = evalId(relativeFile(config.root, file), name)
    const recordPath = join(resultsDir, 'evals', recordFileName(id))
    await mkdir(join(resultsDir, 'evals'), { recursive: true })
    await writeFile(recordPath, JSON.stringify(record, null, 2))
    const last = record.judgements.at(-1)
    const meta: EvalMeta = {
      outcome: record.outcome,
      errorKind: record.error?.kind ?? null,
      verdict: last ? { verdict: last.verdict, reason: last.reason.slice(0, 300) } : null,
      recordPath,
    }
    setMeta(meta)
    await attachRecord(recordPath).catch(() => {})
  }
}
