import { judgeProblem } from '../contract/judge.ts'
import { debugLog, debugTrace } from '../debug/attempt.ts'
import { workspaceFiles } from '../diff.ts'
import { getRunContext, SUBJECT } from '../engine/runtime.ts'
import { globFilter } from '../environment.ts'
import {
  artifactRefsOf,
  badJudgeArtifacts,
  decideState,
  filePartsOf,
  resolveJudgeArtifacts,
} from '../judge/artifacts.ts'
import { judgeModelName, runJudge } from '../judge/index.ts'
import { judgeDiff } from '../judge/patch.ts'
import { isApiError, type RetriedError } from '../judge/retry.ts'
import { withInputSize } from '../judge/size.ts'
import { type Draft, type DraftTurn, stateOf } from '../judge/state.ts'
import { mergeJudge, resolveStateOptions } from '../judge/state-options.ts'
import { transcriptForJudge } from '../judge/transcript.ts'
import { withLease } from '../scheduler/client.ts'
import { clip, formatDuration } from '../text.ts'
import type {
  AttemptContext,
  JSONValue,
  JudgeFailure,
  JudgeInput,
  ResolvedJudgeStateOptions,
  Turn,
} from '../types.ts'
import { requireSandbox } from './checks.ts'
import type { Attempt } from './state.ts'

const noJudgeModel = (configFile: string) =>
  `c.judge() has no model. Set judge: { model: 'typesafe-ai/jev-1.13.0' } in ${configFile}, ` +
  'on the group or eval, or pass { model } to this call.'

const isTurn = (value: unknown): value is Turn =>
  typeof value === 'object' && value !== null && 'transcript' in value && 'diff' in value

const workspacePath = (path: string) => path.replace(/^\.\//, '')

/** A `contents` entry that names one file rather than matching many. */
const isExactPath = (entry: string) => !entry.startsWith('!') && !/[*?[\]{}]/.test(entry)

type StateSources = {
  turns: readonly Turn[]
  subject: Turn
  output: JSONValue
  wanted: ResolvedJudgeStateOptions
  checks: Attempt['record']['checks']
  readFile: (path: string) => Promise<string | null>
  listFiles: () => Promise<string[]>
}

/**
 * The judge's state for what the `state` option chose: the graded turn's task and output (or every turn's),
 * its changed files and diff as `judgeDiff` shows them, files whole, `c.exec` results and the
 * transcript.
 */
async function draftState(src: StateSources): Promise<{ draft: Draft; dropped: string[] }> {
  const { subject, wanted } = src
  const at = src.turns.indexOf(subject)
  const graded = wanted.turns === 'all' && at >= 0 ? src.turns.slice(0, at + 1) : [subject]
  const turns: DraftTurn[] = graded.map((turn) => ({
    ...(wanted.task ? { task: turn.prompt } : {}),
    ...(wanted.output ? { output: turn === subject ? src.output : turn.text } : {}),
    ...(wanted.transcript
      ? { transcript: transcriptForJudge(turn.transcript, wanted.transcript).join('\n') }
      : {}),
  }))
  const contents = await filesWhole(wanted.contents, src)
  const shown = judgeDiff(subject.diff, {
    ...(Array.isArray(wanted.diff) ? { include: wanted.diff } : {}),
    ...(contents ? { inFull: new Set(Object.keys(contents)) } : {}),
  })
  const checks = checksShown(wanted.checks, src.checks)
  const draft: Draft = {
    all: wanted.turns === 'all',
    turns,
    ...(wanted.files ? { files: shown.files } : {}),
    ...(wanted.diff !== false ? { diff: shown.patch } : {}),
    ...(contents ? { contents } : {}),
    ...(checks ? { checks } : {}),
  }
  return { draft, dropped: wanted.diff !== false ? shown.dropped : [] }
}

/** Exact paths (`null` when missing) and every workspace file the patterns match, in path order. */
async function filesWhole(
  entries: readonly string[],
  src: Pick<StateSources, 'readFile' | 'listFiles'>,
): Promise<Record<string, string | null> | undefined> {
  if (!entries.length) return undefined
  const exact = entries.filter(isExactPath).map(workspacePath)
  const matches = globFilter(entries.map(workspacePath))
  const matched = entries.some((e) => !isExactPath(e))
    ? (await src.listFiles()).filter((path) => matches(path))
    : []
  const paths = [...new Set([...exact, ...matched])].sort()
  const contents: Record<string, string | null> = {}
  for (const path of paths) {
    const text = await src.readFile(path)
    contents[path] = text?.includes('\u0000') ? '[reeval: dropped binary file]' : text
  }
  return contents
}

function checksShown(
  which: ResolvedJudgeStateOptions['checks'],
  ran: Attempt['record']['checks'],
): Draft['checks'] {
  if (which === false) return undefined
  if (which !== true) {
    const missing = which.find((command) => !ran.some((r) => r.command === command))
    if (missing !== undefined) {
      throw new Error(
        `c.judge() state.checks names a command this attempt hasn't run: ${JSON.stringify(missing)}`,
      )
    }
  }
  return ran
    .filter((r) => which === true || which.includes(r.command))
    .map(({ command, exitCode, stdout, stderr }) => ({ command, exitCode, stdout, stderr }))
}

/**
 * Grades a turn (the last by default) or a value against a question, under
 * the judge provider's concurrency lease. Every call's input is recorded, including calls that
 * fail. A call that fails returns a `JudgeFailure` and fails the attempt as a judge error after the eval's body, so the judges and
 * checks after it still run.
 */
export function judgeCaller(
  a: Attempt,
  readFile: (path: string) => Promise<string | null>,
): AttemptContext['judge'] {
  const ask: AttemptContext['judge'] = async (question, { on, ...call } = {}) => {
    if (typeof question !== 'string' || !question.trim()) {
      throw new Error(
        `c.judge() needs a question: a non-empty string (got ${JSON.stringify(question)})`,
      )
    }
    const problem = judgeProblem(call, { at: 'call' })
    if (problem) throw new Error(problem)
    const badArts = badJudgeArtifacts(call.artifacts)
    if (badArts) throw new Error(`c.judge() artifacts ${badArts}`)
    const subject = isTurn(on) ? on : a.turns.at(-1)
    if (!subject) throw new Error('c.judge() has no turn to grade: call c.send() first')
    const options = mergeJudge(a.spec.judge, call)
    const { model } = options
    if (model === undefined) {
      a.judgeErrored = true
      throw new Error(noJudgeModel(getRunContext().config.file))
    }
    const wanted = resolveStateOptions(options.state)
    if (on !== undefined && !isTurn(on) && !wanted.output) {
      throw new Error('c.judge() on gives the output, but state.output is false')
    }
    const { state: _state, maxConcurrent, ...judgeOptions } = options
    const output = on === undefined || isTurn(on) ? subject.text : on
    const { draft, dropped } = await draftState({
      turns: a.turns,
      subject,
      output,
      wanted,
      checks: a.record.checks,
      readFile,
      listFiles: () =>
        workspaceFiles(requireSandbox(a, 'c.judge() state.contents patterns'), a.signal),
    })
    const name = judgeModelName(model)
    const state = stateOf(draft)
    const resolved = resolveJudgeArtifacts(call.artifacts, a.artifactBlobs)
    const refs = artifactRefsOf(resolved)
    const decide = decideState(state, filePartsOf(resolved))
    const input: JudgeInput = {
      question,
      model: name,
      stateOptions: wanted,
      state,
      ...(refs.length ? { artifacts: refs } : {}),
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
        ...(refs.length ? { artifacts: refs } : {}),
      }
    }

    const provider = name.split('/')[0]
    try {
      const { verdict, retries } = await a.timed('judgeMs', () =>
        withLease(
          maxConcurrent ? { [`judge:${provider}`]: maxConcurrent } : {},
          () =>
            runJudge(question, decide, { ...judgeOptions, model, threshold: atLeast }, a.signal),
          a.signal,
        ),
      )
      const recorded = refs.length ? { ...verdict, artifacts: refs } : verdict
      a.record.judgements.push(retries.length ? { ...recorded, retries } : recorded)
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
      return recorded
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
  // A verdict names its question in `expect(verdict).toPass()`'s default label.
  return async (question, options) =>
    Object.defineProperty(await ask(question, options), SUBJECT, { value: question })
}
