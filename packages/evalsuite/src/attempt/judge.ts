import { debugLog, debugTrace } from '../debug/attempt.ts'
import { type JudgeState, judgeModelName, runJudge } from '../judge/index.ts'
import { changedFilesForJudge, patchForJudge } from '../judge/patch.ts'
import type { RetriedError } from '../judge/retry.ts'
import { withLease } from '../scheduler/client.ts'
import { clip, formatDuration } from '../text.ts'
import type { EvalContext, JSONValue, JudgeInput, Turn } from '../types.ts'
import type { Attempt } from './state.ts'

const NO_JUDGE_MODEL =
  "t.judge() has no model. Set judge: { model: 'typesafe-ai/jev-1.13.0' } in es.config.ts, " +
  'on the group or eval, or pass { model } to this call.'

const isTurn = (value: unknown): value is Turn =>
  typeof value === 'object' && value !== null && 'transcript' in value && 'diff' in value

function judgeState(turn: Turn, output: JSONValue = turn.text): JudgeState {
  return {
    task: turn.prompt,
    output,
    files: changedFilesForJudge(turn.diff.files),
    diff: patchForJudge(turn.diff.patch),
  }
}

/**
 * Phase 4, the judge: grades a turn (the last by default) or a value against a question, under
 * the judge provider's concurrency lease. Every call's input is recorded, including calls that
 * fail, and a failure marks the attempt's assertion errors as the judge's.
 */
export function judgeCaller(a: Attempt): EvalContext['judge'] {
  return async (question, { on, ...call } = {}) => {
    const subject = isTurn(on) ? on : a.turns.at(-1)
    if (!subject) throw new Error('t.judge() has no turn to grade: call t.send() first')
    const options = { ...a.spec.judge, ...call }
    const { model } = options
    if (model === undefined) {
      a.judgeErrored = true
      throw new Error(NO_JUDGE_MODEL)
    }
    const state = judgeState(subject, on === undefined || isTurn(on) ? undefined : on)
    const input: JudgeInput = { question, model: judgeModelName(model), state }
    a.record.judgeInputs?.push(input)
    const start = performance.now()
    const ms = () => Math.round(performance.now() - start)
    a.report({ kind: 'judge-start', question })
    debugLog('judge', `asking ${input.model}: ${JSON.stringify(clip(question, 160))}`)
    debugTrace('judge', 'prompt', input, 'judge prompt')
    const { maxConcurrent, ...judgeOptions } = options
    const provider = judgeModelName(model).split('/')[0]
    try {
      const { verdict, retries } = await a.timed('judgeMs', () =>
        withLease(
          maxConcurrent ? { [`judge:${provider}`]: maxConcurrent } : {},
          () =>
            runJudge(
              question,
              state,
              { ...judgeOptions, model, threshold: options.threshold ?? 0.8 },
              a.signal,
            ),
          a.signal,
        ),
      )
      a.record.judgements.push(retries.length ? { ...verdict, retries } : verdict)
      const { score, threshold } = verdict
      debugLog(
        'judge',
        `${verdict.resolvedModel ?? verdict.model} · ${formatDuration(ms())} · score ${score.toFixed(2)} ${score >= threshold ? '≥' : '<'} ${threshold} · ${verdict.verdict}${retries.length ? ` · ${retries.length} retries` : ''} · reason: P(yes) ${score.toFixed(2)} is ${score >= threshold ? 'at or above' : 'below'} the ${threshold} threshold`,
      )
      debugTrace('judge', 'response', { verdict, retries }, 'judge response')
      a.report({
        kind: 'judge-end',
        question,
        verdict: verdict.verdict,
        score,
        threshold,
        ms: ms(),
      })
      return verdict
    } catch (error) {
      a.judgeErrored = true
      const { retries } = error as Partial<RetriedError>
      input.error = error instanceof Error ? error.message : String(error)
      if (retries?.length) input.retries = retries
      debugLog('judge', `${input.model} · ${formatDuration(ms())} · error: ${input.error}`)
      debugTrace('judge', 'error', { error: input.error, retries }, 'judge error')
      a.report({
        kind: 'judge-end',
        question,
        verdict: 'error',
        score: null,
        threshold: null,
        ms: ms(),
      })
      throw error
    }
  }
}
