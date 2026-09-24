import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDuration } from './config.ts'
import { diffSinceSnapshot, snapshot } from './diff.ts'
import {
  getRunContext,
  registerGroup,
  registerTest,
  type TestHandle,
  type TestMode,
} from './engine/runtime.ts'
import { createHarness } from './harness/index.ts'
import type { HarnessSession } from './harness/types.ts'
import { evalId, recordFileName, relativeFile } from './ids.ts'
import { type JudgeState, judgeModelName, runJudge } from './judge/index.ts'
import { patchForJudge } from './judge/patch.ts'
import { redactSecrets } from './redact.ts'
import { createSandbox, InfraError, type Sandbox } from './sandbox/index.ts'
import type {
  Diff,
  Duration,
  ErrorKind,
  EvalContext,
  EvalFn,
  EvalMeta,
  EvalRecord,
  JSONValue,
  JudgeOptions,
  Turn,
} from './types.ts'

export type EvalOptions = { timeout?: Duration; judge?: JudgeOptions }
export type GroupOptions = EvalOptions

// The groups enclosing the code being collected. Vitest may run a nested group's callback
// after its parent's callback has returned, so each group captures its parents when declared.
let groupStack: { name: string; options: GroupOptions }[] = []

/** Innermost wins; `judge` merges field by field so a threshold override keeps the model. */
function cascade(own: EvalOptions): EvalOptions {
  const levels = [...groupStack.map((g) => g.options), own]
  return {
    timeout: levels.findLast((l) => l.timeout !== undefined)?.timeout,
    judge: Object.assign({}, ...levels.map((l) => l.judge)),
  }
}

type GroupFn = {
  (name: string, fn: () => void): void
  (name: string, options: GroupOptions, fn: () => void): void
}

const defineGroup =
  (mode: TestMode): GroupFn =>
  (name: string, optionsOrFn: GroupOptions | (() => void), maybeFn?: () => void) => {
    const [options, fn] =
      typeof optionsOrFn === 'function' ? [{}, optionsOrFn] : [optionsOrFn, maybeFn]
    if (typeof fn !== 'function') throw new TypeError(`group("${name}") needs a function`)
    const stack = [...groupStack, { name, options }]
    registerGroup(name, mode, () => {
      const outer = groupStack
      groupStack = stack
      try {
        fn()
      } finally {
        groupStack = outer
      }
    })
  }

export const group: GroupFn & { skip: GroupFn; only: GroupFn } = Object.assign(defineGroup('run'), {
  skip: defineGroup('skip'),
  only: defineGroup('only'),
})

type EvaluateFn = {
  (name: string, fn: EvalFn): void
  (name: string, options: EvalOptions, fn: EvalFn): void
}

const define =
  (mode: TestMode): EvaluateFn =>
  (name: string, optionsOrFn: EvalOptions | EvalFn, maybeFn?: EvalFn) => {
    const [own, fn] = typeof optionsOrFn === 'function' ? [{}, optionsOrFn] : [optionsOrFn, maybeFn]
    if (typeof fn !== 'function') throw new TypeError(`evaluate("${name}") needs a function`)
    const options = cascade(own)
    const timeout = options.timeout === undefined ? undefined : parseDuration(options.timeout)
    const groups = groupStack.map((g) => g.name)
    registerTest(name, { timeout, mode }, (handle) =>
      runEval({ name, groups, timeout, judge: options.judge ?? {} }, fn, handle),
    )
  }

export const evaluate: EvaluateFn & { skip: EvaluateFn; only: EvaluateFn } = Object.assign(
  define('run'),
  { skip: define('skip'), only: define('only') },
)

function classify(error: unknown, signal: AbortSignal): { kind: ErrorKind; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (signal.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason)
    return /timed out/i.test(reason)
      ? { kind: 'timeout', message: 'The eval timed out' }
      : { kind: 'aborted', message: 'The run was cancelled' }
  }
  if (error instanceof InfraError) return { kind: 'infra', message }
  return { kind: 'assertion', message }
}

const isTurn = (value: unknown): value is Turn =>
  typeof value === 'object' && value !== null && 'transcript' in value && 'diff' in value

function judgeState(turn: Turn, output: JSONValue = turn.text): JudgeState {
  return {
    task: turn.prompt,
    output,
    files: turn.diff.files.map((f) => `${f.status} ${f.path}`),
    diff: patchForJudge(turn.diff.patch),
  }
}

type EvalSpec = { name: string; groups: string[]; timeout?: number; judge: JudgeOptions }

async function runEval(
  spec: EvalSpec,
  fn: EvalFn,
  { file, signal, setMeta, attachRecord }: TestHandle,
): Promise<void> {
  const { runId, resultsDir, config } = getRunContext()
  const record: EvalRecord = {
    outcome: 'pass',
    error: null,
    turns: [],
    diff: null,
    checks: [],
    judgements: [],
    judgeInputs: [],
  }
  const turns: Turn[] = []
  let sandbox: Sandbox | undefined
  let session: HarnessSession | undefined
  let judgeErrored = false
  const destroy = () => void sandbox?.destroy()
  signal.addEventListener('abort', destroy, { once: true })

  const requireSandbox = () => {
    if (!sandbox) throw new Error('No sandbox yet: call t.send() before t.exec() or t.readFile()')
    return sandbox
  }
  const exec = async (command: string) => {
    const r = await requireSandbox().exec(command, { signal })
    record.checks.push({ command, ...r })
    return r
  }
  const readFile = (path: string) => requireSandbox().readFile(path)

  async function startSession(): Promise<[Sandbox, HarnessSession]> {
    const lifetimeMs = (spec.timeout ?? config.timeoutMs) + 60_000
    const box = await createSandbox(config.sandbox, { runId, timeoutMs: lifetimeMs, signal })
    sandbox = box
    if (signal.aborted) destroy()
    signal.throwIfAborted()
    await snapshot(box, signal)
    const harness = await createHarness(config.harness)
    session = await harness.start(box, signal)
    return [box, session]
  }

  const t: EvalContext = {
    signal,
    turns,
    exec,
    readFile,
    async send(prompt) {
      const [box, agent] = sandbox && session ? [sandbox, session] : await startSession()
      const entry = { prompt, text: '', status: 'error' as const, transcript: [] }
      record.turns.push(entry)
      const result = await agent.send(prompt, signal)
      Object.assign(entry, result)
      signal.throwIfAborted()
      const diff: Diff = await diffSinceSnapshot(box, signal)
      record.diff = diff
      const turn: Turn = Object.freeze({ prompt, ...result, diff, exec, readFile })
      turns.push(turn)
      return turn
    },
    async judge(question, { on, ...call } = {}) {
      const subject = isTurn(on) ? on : turns.at(-1)
      if (!subject) throw new Error('t.judge() has no turn to grade: call t.send() first')
      const state = judgeState(subject, on === undefined || isTurn(on) ? undefined : on)
      const options = { ...config.judge, ...spec.judge, ...call }
      record.judgeInputs?.push({ question, model: judgeModelName(options.model), state })
      try {
        const verdict = await runJudge(question, state, options, signal)
        record.judgements.push(verdict)
        return verdict
      } catch (error) {
        judgeErrored = true
        throw error
      }
    },
  }

  try {
    await fn(t)
    // A body that ignores the signal can still return normally after a timeout or cancel.
    signal.throwIfAborted()
  } catch (error) {
    record.error = classify(error, signal)
    const judgeFailed = judgeErrored || record.judgements.some((j) => j.verdict !== 'pass')
    if (record.error.kind === 'assertion' && judgeFailed) record.error.kind = 'judge'
    record.outcome = record.error.kind === 'infra' ? 'infra_error' : 'fail'
    throw error
  } finally {
    signal.removeEventListener('abort', destroy)
    await session?.close().catch(() => {})
    await sandbox?.destroy()
    const id = evalId(relativeFile(config.root, file), [...spec.groups, spec.name])
    const recordPath = join(resultsDir, 'evals', recordFileName(id))
    await mkdir(join(resultsDir, 'evals'), { recursive: true })
    await writeFile(recordPath, redactSecrets(JSON.stringify(record, null, 2)))
    const meta: EvalMeta = {
      outcome: record.outcome,
      errorKind: record.error?.kind ?? null,
      judgements: record.judgements.map((j) => ({
        verdict: j.verdict,
        score: j.score,
        threshold: j.threshold,
        question: j.question.slice(0, 200),
      })),
      recordPath,
    }
    setMeta(meta)
    await attachRecord(recordPath).catch(() => {})
  }
}
