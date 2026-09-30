import { debugLog, debugTrace } from '../debug/attempt.ts'
import { getRunContext } from '../engine/runtime.ts'
import { badJudgeList, type JudgeState, judgeModelName, runJudge } from '../judge/index.ts'
import { judgeDiff } from '../judge/patch.ts'
import { isApiError, type RetriedError } from '../judge/retry.ts'
import { withInputSize } from '../judge/size.ts'
import { withLease } from '../scheduler/client.ts'
import { clip, formatDuration } from '../text.ts'
import type {
  AttemptContext,
  JSONValue,
  JudgeFailure,
  JudgeInput,
  JudgeOptions,
  Turn,
} from '../types.ts'
import type { Attempt } from './state.ts'

const noJudgeModel = (configFile: string) =>
  `c.judge() has no model. Set judge: { model: 'typesafe-ai/jev-1.13.0' } in ${configFile}, ` +
  'on the group or eval, or pass { model } to this call.'

const isTurn = (value: unknown): value is Turn =>
  typeof value === 'object' && value !== null && 'transcript' in value && 'diff' in value

const workspacePath = (path: string) => path.replace(/^\.\//, '')

/**
 * The turn's task and output, its changed files and diff as `judgeDiff` shows them, and the whole
 * current content of each of `files` (null when there's no such file).
 */
async function judgeState(
  turn: Turn,
  output: JSONValue,
  { include, files }: Pick<JudgeOptions, 'include' | 'files'>,
  readFile: (path: string) => Promise<string | null>,
): Promise<{ state: JudgeState; dropped: string[] }> {
  const inFull = files?.length ? files : undefined
  const shown = judgeDiff(turn.diff, {
    ...(include ? { include } : {}),
    ...(inFull ? { inFull: new Set(inFull.map(workspacePath)) } : {}),
  })
  const state: JudgeState = { task: turn.prompt, output, files: shown.files, diff: shown.patch }
  if (inFull) {
    const contents: { [path: string]: string | null } = {}
    for (const path of inFull) contents[workspacePath(path)] = await readFile(path)
    state.contents = contents
  }
  return { state, dropped: shown.dropped }
}

/**
 * Phase 4, the judge: grades a turn (the last by default) or a value against a question, under
 * the judge provider's concurrency lease. Every call's input is recorded, including calls that
 * fail. A call that fails returns a `JudgeFailure` and fails the attempt as a judge error after the eval's body, so the judges and
 * checks after it still run.
 */
export function judgeCaller(
  a: Attempt,
  readFile: (path: string) => Promise<string | null>,
): AttemptContext['judge'] {
  return async (question, { on, ...call } = {}) => {
    if (typeof question !== 'string' || !question.trim()) {
      throw new Error(
        `c.judge() needs a question: a non-empty string (got ${JSON.stringify(question)})`,
      )
    }
    const { threshold } = call
    if (
      threshold !== undefined &&
      !(typeof threshold === 'number' && threshold >= 0 && threshold <= 1)
    ) {
      throw new Error(`c.judge() threshold must be between 0 and 1 (got ${String(threshold)})`)
    }
    const bad = badJudgeList(call)
    if (bad)
      throw new Error(`c.judge() ${bad.key} must be a list of non-empty strings (got ${bad.got})`)
    const subject = isTurn(on) ? on : a.turns.at(-1)
    if (!subject) throw new Error('c.judge() has no turn to grade: call c.send() first')
    const options = { ...a.spec.judge, ...call }
    const { model } = options
    if (model === undefined) {
      a.judgeErrored = true
      throw new Error(noJudgeModel(getRunContext().config.file))
    }
    const { include, files, maxConcurrent, ...judgeOptions } = options
    const output = on === undefined || isTurn(on) ? subject.text : on
    const { state, dropped } = await judgeState(subject, output, { include, files }, readFile)
    const name = judgeModelName(model)
    const input: JudgeInput = {
      question,
      model: name,
      state,
      ...(dropped.length ? { dropped } : {}),
    }
    a.record.judgeInputs?.push(input)
    const start = performance.now()
    const ms = () => Math.round(performance.now() - start)
    const atLeast = options.threshold ?? 0.8
    a.report({ kind: 'judge-start', question })
    debugLog('judge', `asking ${name}: ${JSON.stringify(clip(question, 160))}`)
    if (dropped.length) debugLog('judge', `left out of the judge's input: ${dropped.join(' · ')}`)
    debugTrace('judge', 'prompt', input, 'judge prompt')

    const failed = (message: string, retries?: RetriedError['retries']): JudgeFailure => {
      a.judgeErrored = true
      a.judgeErrors.push(`c.judge(${JSON.stringify(clip(question, 80))}) failed: ${message}`)
      input.error = message
      if (retries?.length) input.retries = retries
      debugLog('judge', `${name} · ${formatDuration(ms())} · error: ${message}`)
      debugTrace('judge', 'error', { error: message, retries }, 'judge error')
      a.report({
        kind: 'judge-end',
        question,
        verdict: 'error',
        score: null,
        threshold: null,
        ms: ms(),
      })
      return {
        verdict: 'error',
        score: null,
        threshold: atLeast,
        question,
        model: name,
        error: message,
      }
    }

    const provider = name.split('/')[0]
    try {
      const { verdict, retries } = await a.timed('judgeMs', () =>
        withLease(
          maxConcurrent ? { [`judge:${provider}`]: maxConcurrent } : {},
          () => runJudge(question, state, { ...judgeOptions, model, threshold: atLeast }, a.signal),
          a.signal,
        ),
      )
      a.record.judgements.push(retries.length ? { ...verdict, retries } : verdict)
      const { score } = verdict
      debugLog(
        'judge',
        `${verdict.resolvedModel ?? verdict.model} · ${formatDuration(ms())} · score ${score.toFixed(2)} ${score >= verdict.threshold ? '≥' : '<'} ${verdict.threshold} · ${verdict.verdict}${retries.length ? ` · ${retries.length} retries` : ''} · reason: P(yes) ${score.toFixed(2)} is ${score >= verdict.threshold ? 'at or above' : 'below'} the ${verdict.threshold} threshold`,
      )
      debugTrace('judge', 'response', { verdict, retries }, 'judge response')
      a.report({
        kind: 'judge-end',
        question,
        verdict: verdict.verdict,
        score,
        threshold: verdict.threshold,
        ms: ms(),
      })
      return verdict
    } catch (error) {
      if (a.signal.aborted) {
        a.judgeErrored = true
        throw error
      }
      const { retries } = error as Partial<RetriedError>
      const message = error instanceof Error ? error.message : String(error)
      return failed(isApiError(error) ? withInputSize(message, state, question) : message, retries)
    }
  }
}
