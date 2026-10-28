import type { JudgeOn } from '../contract/attempt.ts'
import { INPUT_KEYS, inputsOn, judgeProblem, NO_JUDGE_INPUT } from '../contract/judge.ts'
import { debugLog, debugTrace } from '../debug/attempt.ts'
import { workspaceFiles } from '../diff.ts'
import { getRunContext, SUBJECT } from '../engine/runtime.ts'
import { globFilter } from '../environment.ts'
import { gatewayScope, resolveModelGateway } from '../gateway/models.ts'
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
import { redactSecrets, redactValue } from '../redact.ts'
import { withLease } from '../scheduler/client.ts'
import { clip, formatDuration } from '../text.ts'
import type {
  AttemptContext,
  JSONValue,
  JudgeCallFields,
  JudgeCallOptions,
  JudgeFailure,
  JudgeInput,
  ResolvedJudgeStateOptions,
  Turn,
  Verdict,
} from '../types.ts'
import { sandboxFor } from './checks.ts'
import type { Attempt } from './state.ts'

const noJudgeModel = (configFile: string) =>
  `c.judge() has no model. Set judge: { model: 'typesafe-ai/jev-1.14.0' } in ${configFile}, ` +
  'on the group or eval, or pass { model } to this call.'

/** A turn this attempt sent becomes its index; any other value is graded as the output. */
function judgeOn(turns: readonly Turn[], on: Turn | JSONValue): JudgeOn {
  const turn = turns.indexOf(on as Turn)
  if (turn >= 0) return { turn }
  if (typeof on === 'object' && typeof (on as Partial<Turn> | null)?.exec === 'function') {
    throw new Error("c.judge() on is a turn this attempt didn't send")
  }
  return { value: on as JSONValue }
}

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
 * The judge's state for the inputs the call turned on: the graded turn's task and output (or every turn's),
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
    ...(Array.isArray(wanted.diff) ? { patterns: wanted.diff } : {}),
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
        `c.judge() checks names a command this attempt hasn't run: ${JSON.stringify(missing)}`,
      )
    }
  }
  return ran
    .filter((r) => which === true || which.includes(r.command))
    .map(({ command, exitCode, stdout, stderr }) => ({ command, exitCode, stdout, stderr }))
}

/**
 * Where `order` goes among `calls`, which are in ascending order: calls finish in any order, but
 * what they record stays in the order they were made.
 */
function placeFor(calls: readonly number[], order: number): number {
  const after = calls.findIndex((c) => c > order)
  return after < 0 ? calls.length : after
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
  const ask = async (
    order: number,
    question: string,
    { on, ...call }: Omit<JudgeCallFields, 'on'> & { on?: JudgeOn },
  ): Promise<Verdict | JudgeFailure> => {
    const problem = judgeProblem(call, { at: 'call' })
    if (problem) throw new Error(problem)
    const badArts = badJudgeArtifacts(call.artifacts)
    if (badArts) throw new Error(`c.judge() artifacts ${badArts}`)
    const subject = on && 'turn' in on ? a.turns[on.turn] : a.turns.at(-1)
    if (!subject) {
      throw new Error(
        on && 'turn' in on
          ? `c.judge() on names turn ${on.turn}, but this attempt has ${a.turns.length}`
          : 'c.judge() has no turn to grade: call c.send() first',
      )
    }
    const wanted = resolveStateOptions(call)
    if (on && 'value' in on && !wanted.output) {
      throw new Error(
        'c.judge() on gives a value to grade as the output, but output is off. Pass output: true.',
      )
    }
    const {
      task: _task,
      output: _output,
      files: _files,
      diff: _diff,
      contents: _contents,
      transcript: _transcript,
      turns: _turns,
      checks: _checks,
      artifacts,
      ...callJudge
    } = call
    const options = mergeJudge(a.spec.judge, callJudge)
    const { model } = options
    if (model === undefined) {
      const message = noJudgeModel(getRunContext().config.file)
      a.judgeThrown.add(message)
      throw new Error(message)
    }
    const { maxConcurrent, ...judgeOptions } = options
    const output = on && 'value' in on ? on.value : subject.text
    const { draft, dropped } = await draftState({
      turns: a.turns,
      subject,
      output,
      wanted,
      checks: a.record.checks,
      readFile,
      listFiles: async () => workspaceFiles(await sandboxFor(a, 'c.judge()'), a.signal),
    })
    const name = judgeModelName(model)
    // Masked as the record will be, so judge-input.json is what the model was sent.
    const state = redactValue(stateOf(draft))
    const resolved = resolveJudgeArtifacts(artifacts, a.artifactBlobs)
    if (artifacts === true && !resolved.length && inputsOn(call, INPUT_KEYS).length === 1) {
      throw new Error(
        'c.judge() artifacts: true shows the judge nothing yet: this attempt has no captures. Call c.capture() first, or turn on another input.',
      )
    }
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
    const place = placeFor(a.judgeInputCalls, order)
    a.judgeInputCalls.splice(place, 0, order)
    a.record.judgeInputs?.splice(place, 0, input)
    const start = performance.now()
    const ms = () => Math.round(performance.now() - start)
    const atLeast = options.threshold ?? 0.8
    a.report({ kind: 'judge-start', question })
    debugLog('judge', `asking ${name}: ${JSON.stringify(clip(redactSecrets(question), 160))}`)
    if (dropped.length) debugLog('judge', `left out of the judge's input: ${dropped.join(' · ')}`)
    debugTrace('judge', 'prompt', input, 'judge prompt')

    const failed = (message: string, retries?: RetriedError['retries']): JudgeFailure => {
      a.judgeErrors.push({
        call: order,
        message: `c.judge(${JSON.stringify(clip(redactSecrets(question), 80))}) failed: ${message}`,
      })
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
      const { config, profile } = getRunContext()
      const scope = gatewayScope(config, profile)
      const gateway = resolveModelGateway(model, judgeOptions.gateway, scope, 'judge model')
      const { gateway: _pin, ...unpinned } = judgeOptions
      // The list's entry, so the judge gets its settings (OpenRouter's fallbacks,
      // Vertex's project and regions).
      const entry = gateway && scope.gateways.find((g) => g.kind === gateway)
      const routed = gateway ? { ...unpinned, gateway: entry || gateway } : unpinned
      const { verdict, retries } = await a.timed('judgeMs', () =>
        withLease(
          maxConcurrent ? { [`judge:${provider}`]: maxConcurrent } : {},
          () => runJudge(question, decide, { ...routed, model, threshold: atLeast }, a.signal),
          a.signal,
        ),
      )
      const recorded = refs.length ? { ...verdict, artifacts: refs } : verdict
      const { judgements: judgments } = a.record
      judgments.splice(
        placeFor(
          judgments.map((j) => j.call ?? 0),
          order,
        ),
        0,
        { ...recorded, ...(retries.length ? { retries } : {}), call: order },
      )
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
      if (a.signal.aborted) throw error
      const { retries } = error as Partial<RetriedError>
      const message = error instanceof Error ? error.message : String(error)
      return failed(isApiError(error) ? withInputSize(message, state, question) : message, retries)
    }
  }
  // A verdict names its question in `expect(verdict).toPass()`'s default label.
  return async (question, given: JudgeCallOptions) => {
    if (typeof question !== 'string' || !question.trim()) {
      throw new Error(
        `c.judge() needs a question: a non-empty string (got ${JSON.stringify(question)})`,
      )
    }
    if (given === null || typeof given !== 'object' || Array.isArray(given)) {
      throw new Error(judgeProblem(given, { at: 'call' }) ?? NO_JUDGE_INPUT)
    }
    const { on, ...options } = given
    const order = a.judgeCalls++
    const call = on === undefined ? options : { ...options, on: judgeOn(a.turns, on) }
    return Object.defineProperty(await ask(order, question, call), SUBJECT, { value: question })
  }
}
