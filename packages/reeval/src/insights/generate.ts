// A run's insights from its record: per eval, one classification call (the name read first, and
// skipped when the classification is cached) and one insights call on its scoped facts, cut to
// `EVAL_INPUT_CHARS` (`trim.ts`), then one headline call for the run, each checked by the
// validator. A sentence the banned-word lint refuses is asked for once more, then dropped.
// `maxTokens` is spent on the evals most worth explaining first (`priority.ts`), each reserving an
// estimate before it starts (`budget.ts`); once the next one can't fit, no eval's calls start, and
// those in flight finish. Every call has `CALL_TIMEOUT_MS` and `INSIGHT_OUTPUT_TOKENS`; an eval
// whose call fails, is cut off or times out is tried once more, then prints its facts alone, and
// no other eval is touched. The insights call also returns the eval's remarks, which the gates
// (`remarks.ts`) hold to the eval's source as the run saw it. Nothing here
// reads or changes a verdict: the facts are final before any call starts.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generateText, type LanguageModel, NoObjectGeneratedError, Output } from 'ai'
import type { z } from 'zod'
import { cannedModel, providerModel, type ResolvedAnalysisModel } from '../analysis/model.ts'
import type { RunRecord } from '../history/types.ts'
import type { Candidate } from '../remarks/rules.ts'
import { formatDuration } from '../text.ts'
import type { FakeInsights } from '../types.ts'
import { slotsOf } from '../ui/layout.ts'
import type { EvalInsight, Job, Remark, RunInsights, Sentence } from '../view/insights.ts'
import { type EvalResult, isStudy, type SuiteResult, suiteResult } from '../view/suite.ts'
import { admit, ledger, reserve, settle } from './budget.ts'
import type { Classified, ClassifyCache } from './classify.ts'
import { factsHash } from './hash.ts'
import {
  attemptTexts,
  classificationKey,
  entriesOf,
  evalInput,
  evalSource,
  type HeadlineInput,
  type Ids,
  type InsightInput,
  type ModelHeadlineInput,
  type ModelInsightInput,
  modelHeadlineInput,
  modelInput,
  withoutIdLists,
} from './input.ts'
import { byPriority } from './priority.ts'
import { gateRemarks } from './remarks.ts'
import {
  CLASSIFY_PROMPT,
  type ClassificationOutput,
  classificationSchema,
  HEADLINE_PROMPT,
  type HeadlineOutput,
  headlineSchema,
  type InsightsOutput,
  insightsPrompt,
  insightsPromptVersion,
  insightsSchema,
} from './schema.ts'
import { EVAL_INPUT_CHARS, trimInput } from './trim.ts'
import { type Checked, type Drop, validateEvalInsights, validateHeadline } from './validate.ts'

/**
 * Each call's output cap, reasoning included. The largest insight call on a 104-eval suite on
 * `google/gemini-3.8-flash` wrote 9.8k tokens, 97% of it thinking (the 95th percentile, 6k); the
 * cap leaves twice the largest, so only a reply that has run away is cut off.
 */
export const INSIGHT_OUTPUT_TOKENS = 20_000

/**
 * How long one call may take before it counts as hung. The slowest call on that suite took 68s
 * (the 95th percentile, 46s); a provider that's merely slow finishes well inside this.
 */
export const CALL_TIMEOUT_MS = 180_000

export type InsightOptions = {
  record: RunRecord
  /** The run's folder, for failed attempts' transcripts; null to send none. */
  runDir: string | null
  model: ResolvedAnalysisModel
  /**
   * The project's root, where the evals' source files are: the model sees each eval's declaration
   * and its remarks are checked against it. Without it the model is shown no source, and no remark
   * is kept.
   */
  root?: string
  /** Each call's output cap; default `INSIGHT_OUTPUT_TOKENS`. */
  maxOutputTokens?: number
  /** Each eval's input cap, in characters; default `EVAL_INPUT_CHARS`. */
  maxInputChars?: number
  /** Each call's timeout; default `CALL_TIMEOUT_MS`. */
  callTimeoutMs?: number
  /** Evals asked about at once. */
  concurrency?: number
  /** Tokens (in and out) over every call; once spent, no eval's calls start. Default: no cap. */
  maxTokens?: number
  /** Classifications already made, by key; none to classify every eval. */
  cache?: ClassifyCache
  /**
   * A document to finish: only its stopped, failed and budget-skipped evals are asked about, and
   * its sentences, headline, usage and validation are kept.
   */
  prior?: RunInsights
  /** Ctrl-C: stops every call, starts no more and returns what finished, in `stopped`. */
  signal?: AbortSignal
  /** Which signal `signal` stands for, for `stopped`. */
  stopSignal?: () => 'SIGINT' | 'SIGTERM'
  /** Each call's tokens as it returns. */
  onUsage?: (call: CallUsage) => void
  /** Evals settled (with insights, failed or skipped) of those to ask about, as each settles. */
  onProgress?: (done: number, total: number) => void
}

type Usage = { inputTokens: number; outputTokens: number; reasoningTokens: number }
type Call = 'classify' | 'insights' | 'headline'

/** One call's tokens and time: `eval` is its eval's path, or null for the headline. */
export type CallUsage = { call: Call; eval: string | null; ms: number } & Usage
type ModelInput = ModelInsightInput | ModelHeadlineInput
type Counts = { dropped: number; regenerated: number; drops: Drop[] }

/** The part of a fake's answer one call returns, as the model's JSON would have it. */
function fakePart(call: Call, answer: FakeInsights, input: ModelInput): unknown {
  if (call === 'classify') {
    const i = answer.intent
    return {
      job: i?.job ?? 'other',
      question: i?.question ?? (input.call === 'headline' ? '' : input.eval.name),
      subject: { tool: i?.subject?.tool ?? null, change: i?.subject?.change ?? null },
      name: i?.name ?? 'states-intent',
      confidence: i?.confidence ?? 'high',
    }
  }
  if (call === 'headline') return { headline: answer.headline ?? null }
  return {
    answer: answer.answer ?? null,
    findings: answer.findings ?? [],
    rows: answer.rows ?? [],
    namedTools: answer.namedTools ?? [],
    remarks: (answer.remarks ?? []).map((r) => ({
      kind: r.kind,
      text: r.text,
      source: r.source ?? null,
      evidence: r.evidence ?? [],
      fix: r.fix ?? null,
    })),
  }
}

/** `work`, or the signal's reason as soon as it aborts. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

async function languageModel(
  model: ResolvedAnalysisModel,
  call: Call,
  input: ModelInput,
  signal: AbortSignal | undefined,
): Promise<LanguageModel> {
  if (!model.fake) return providerModel(model)
  const insights = model.fake.insights
  if (insights === undefined) {
    throw new Error('fakeAnalysis() has no insights, so it has none to return')
  }
  if (typeof insights === 'object' && insights !== null && 'error' in insights) {
    return cannedModel({ error: insights.error })
  }
  const answer =
    typeof insights === 'function'
      ? await abortable(Promise.resolve(insights(input)), signal)
      : insights
  return cannedModel({ text: JSON.stringify(fakePart(call, answer, input)) }, true)
}

type SdkUsage = {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  outputTokenDetails?: { reasoningTokens?: number | undefined }
}

async function ask<S extends z.ZodType>(
  o: InsightOptions,
  call: Call,
  schema: S,
  system: string,
  input: ModelInput,
  usage: Usage,
): Promise<z.infer<S>> {
  const timeoutMs = o.callTimeoutMs ?? CALL_TIMEOUT_MS
  const maxOutputTokens = o.maxOutputTokens ?? INSIGHT_OUTPUT_TOKENS
  // Its own timer, not AbortSignal.timeout's: a hung call must keep the process waiting for it.
  const clock = new AbortController()
  const timer = setTimeout(() => clock.abort(), timeoutMs)
  const timeout = clock.signal
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
  const started = Date.now()
  const count = (u: SdkUsage | undefined) => {
    const used: Usage = {
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
      reasoningTokens: u?.outputTokenDetails?.reasoningTokens ?? 0,
    }
    addUsage(usage, used)
    const ms = Date.now() - started
    o.onUsage?.({ call, eval: input.call === 'headline' ? null : input.eval.path, ms, ...used })
  }
  const cutOff = new Error(`the ${call} reply was cut off at ${maxOutputTokens} output tokens`)
  let result: Awaited<ReturnType<typeof generateText>>
  try {
    result = await generateText({
      model: await languageModel(o.model, call, input, signal),
      system,
      prompt: JSON.stringify(input),
      output: Output.object({ schema, name: call }),
      maxOutputTokens,
      maxRetries: 3,
      abortSignal: signal,
    })
  } catch (error) {
    if (o.signal?.aborted) throw o.signal.reason
    if (timeout.aborted) {
      throw new Error(`the ${call} call took longer than ${formatDuration(timeoutMs)}`)
    }
    if (NoObjectGeneratedError.isInstance(error)) {
      count(error.usage)
      if (error.finishReason === 'length') throw cutOff
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
  count(result.usage)
  if (result.finishReason === 'length') throw cutOff
  return result.output as z.infer<S>
}

const sentenceFrom = <S extends Sentence>(s: S, ids: Ids): S => ({
  ...s,
  text: withoutIdLists(s.text),
  cites: s.cites.map(ids.cite),
})

/** The model's sentences with its short ids turned back into paths, for the validator and the file. */
function fromModel(out: InsightsOutput, ids: Ids): InsightsOutput {
  return {
    answer: out.answer && sentenceFrom(out.answer, ids),
    findings: out.findings.map((s) => sentenceFrom(s, ids)),
    rows: out.rows.map((r) => ({ ...sentenceFrom(r, ids), row: ids.row(r.row) })),
    namedTools: out.namedTools.map((n) => ({ ...n, attempt: ids.attempt(n.attempt) })),
    remarks: out.remarks.map((r) => ({ ...r, evidence: r.evidence.map(ids.cite) })),
  }
}

/** How a refused sentence is put to the model when it's asked again. */
const retryLine = (d: Drop) => `${d.slot}: "${d.text}" ${d.reason}`

/** Checks an answer, and asks once more when the lint refused a sentence; what's refused twice is dropped. */
async function checked<T, O>(
  first: O,
  again: (retry: string[]) => Promise<O>,
  check: (output: O) => Checked<T>,
  counts: Counts,
): Promise<T> {
  const one = check(first)
  if (!one.banned.length) {
    counts.dropped += one.dropped.length
    counts.drops.push(...one.dropped)
    return one.value
  }
  counts.regenerated += one.banned.length
  const two = check(await again(one.banned.map(retryLine)))
  const drops = [...two.dropped, ...two.banned]
  counts.dropped += drops.length
  counts.drops.push(...drops)
  return two.value
}

/** One classification call; a low-confidence one falls back to `other`. */
async function classify(
  o: InsightOptions,
  base: Omit<InsightInput, 'call'>,
  usage: Usage,
): Promise<Classified> {
  const out = (await ask(
    o,
    'classify',
    classificationSchema,
    CLASSIFY_PROMPT,
    modelInput({ call: 'classify', ...base }).input,
    usage,
  )) as ClassificationOutput
  const job: Job = out.confidence === 'low' ? 'other' : out.job
  return {
    job,
    question: out.question,
    subject: {
      ...(out.subject.tool ? { tool: out.subject.tool } : {}),
      ...(out.subject.change ? { change: out.subject.change } : {}),
    },
    name: out.name,
  }
}

/** An eval's insight and the model's remarks on it that passed the gates. */
type Explained = { insight: EvalInsight; remarks: Candidate[] }

/** Each of the eval's source files as it is now, for the gates to hold a remark's quote to. */
async function sourceFiles(root: string | undefined, record: RunRecord, e: EvalResult) {
  const files = new Map<string, string | null>()
  if (!root) return files
  for (const { entry } of entriesOf(record, e)) {
    for (const s of entry.sources) {
      if (!files.has(s.path)) {
        files.set(s.path, await readFile(join(root, s.path), 'utf8').catch(() => null))
      }
    }
  }
  return files
}

async function evalInsight(
  o: InsightOptions,
  e: EvalResult,
  usage: Usage,
  counts: Counts,
): Promise<Explained> {
  const full = await evalInput(o.record, o.runDir, e)
  const cap = o.maxInputChars ?? EVAL_INPUT_CHARS
  const key = classificationKey(o.record, e, o.model.name, insightsPromptVersion())
  const classified = (await o.cache?.get(key)) ?? (await classify(o, trimInput(full, cap), usage))
  if (o.cache) await o.cache.set(key, classified).catch(() => {})
  const { job, subject } = classified
  const slots = slotsOf(job, e)
  const source = o.root ? await evalSource(o.root, o.record, e) : null
  const base = trimInput(source ? { ...full, source } : full, cap, slots.rows)
  const input: InsightInput = {
    call: 'insights',
    ...base,
    intent: { job, question: classified.question, subject },
    slots,
  }
  const model = modelInput(input)
  const askInsights = async (retry?: string[]) =>
    fromModel(
      (await ask(
        o,
        'insights',
        insightsSchema,
        insightsPrompt(),
        retry ? { ...model.input, retry } : model.input,
        usage,
      )) as InsightsOutput,
      model.ids,
    )
  const texts = attemptTexts(o.record, e)
  let last: InsightsOutput | null = null
  const sentences = await checked(
    await askInsights(),
    askInsights,
    (out) => {
      last = out
      return validateEvalInsights(out, input, slots, texts)
    },
    counts,
  )
  const gated = gateRemarks((last as InsightsOutput | null)?.remarks ?? [], {
    input,
    entries: entriesOf(o.record, e).map((x) => x.entry),
    files: await sourceFiles(o.root, o.record, e),
  })
  counts.dropped += gated.dropped.length
  counts.drops.push(...gated.dropped)
  return {
    insight: {
      evalId: e.path,
      intent: {
        job,
        across: e.across,
        question: classified.question,
        subject,
        name: classified.name,
        key,
      },
      ...sentences,
    },
    remarks: gated.kept,
  }
}

/** The evals that get an insight, in the order the output prints them: none for a todo or a skip. */
export const insightEvals = (suite: SuiteResult) =>
  suite.files.flatMap((f) =>
    [...f.evals]
      .sort((a, b) => a.order - b.order)
      .filter((e) => !e.todo && e.outcome !== 'skipped'),
  )

/**
 * An eval's insight, asked for once more when a call fails, is cut off or times out; its sentences
 * counted only once it lands. Ctrl-C isn't a failure: it rejects at once.
 */
async function evalInsightOnce(
  o: InsightOptions,
  e: EvalResult,
  usage: Usage,
  validation: Counts,
): Promise<Explained> {
  for (let tries = 1; ; tries++) {
    const counts: Counts = { dropped: 0, regenerated: 0, drops: [] }
    try {
      const insight = await evalInsight(o, e, usage, counts)
      validation.dropped += counts.dropped
      validation.regenerated += counts.regenerated
      validation.drops.push(...counts.drops)
      return insight
    } catch (error) {
      if (tries === 2 || o.signal?.aborted) throw error
    }
  }
}

const spent = (u: Usage) => u.inputTokens + u.outputTokens

function addUsage(to: Usage, from: Usage) {
  to.inputTokens += from.inputTokens
  to.outputTokens += from.outputTokens
  to.reasoningTokens += from.reasoningTokens
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Resolves on the signal's abort, so a wait on calls in flight ends with Ctrl-C. */
const aborted = (signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (!signal) return
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })

/**
 * Classifies each eval, writes and checks its sentences, then the run's headline. Evals start in
 * priority order and are kept in output order; with `maxTokens`, those it didn't reach are listed
 * in `budget.skipped`. An eval that fails twice is in `failed` and the others go on; on `signal`,
 * those that hadn't finished are in `stopped`. It rejects only when every eval it asked about
 * failed, with the first error.
 */
export async function generateInsights(o: InsightOptions): Promise<RunInsights> {
  const suite = suiteResult(o.record)
  const prior = o.prior
  const usage: Usage = {
    inputTokens: prior?.usage.inputTokens ?? 0,
    outputTokens: prior?.usage.outputTokens ?? 0,
    reasoningTokens: prior?.usage.reasoningTokens ?? 0,
  }
  const validation: Counts = {
    dropped: prior?.validation.dropped ?? 0,
    regenerated: prior?.validation.regenerated ?? 0,
    drops: [...(prior?.validation.drops ?? [])],
  }
  const budget = o.maxTokens === undefined ? null : ledger(o.maxTokens)
  const all = insightEvals(suite)
  const kept = new Map((prior?.evals ?? []).map((e) => [e.evalId, e]))
  const pending = prior && unfinishedEvals(prior)
  const ordered = pending ? all.filter((e) => pending.has(e.path)) : all
  const skipped = new Set<string>()
  const done = new Map<string, Explained>()
  const failed = new Map<string, unknown>()
  const running = new Set<Promise<void>>()
  const concurrency = o.concurrency ?? 4
  const stop = aborted(o.signal)
  const stopped = () => o.signal?.aborted === true
  const progress = () => o.onProgress?.(done.size + failed.size + skipped.size, ordered.length)
  const settled = () => Promise.race([stop, ...running])
  for (const e of byPriority(ordered)) {
    let decision: 'start' | 'skip' = 'start'
    for (;;) {
      if (stopped()) break
      if (running.size >= concurrency) {
        await settled()
        continue
      }
      const next = budget ? admit(budget) : 'start'
      if (next !== 'wait') {
        decision = next
        break
      }
      await settled()
    }
    if (stopped()) break
    if (decision === 'skip') {
      skipped.add(e.path)
      progress()
      continue
    }
    const held = budget ? reserve(budget) : 0
    const used: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
    const call: Promise<void> = evalInsightOnce(o, e, used, validation)
      .then((insight) => void done.set(e.path, insight))
      .catch((error) => {
        if (!stopped()) failed.set(e.path, error)
      })
      .finally(() => {
        if (budget) settle(budget, held, spent(used))
        addUsage(usage, used)
        running.delete(call)
        if (!stopped()) progress()
      })
    running.add(call)
  }
  await Promise.all(running)
  if (!stopped() && !done.size && failed.size) throw failed.values().next().value
  const left = ordered.flatMap((e) =>
    done.has(e.path) || failed.has(e.path) || skipped.has(e.path) ? [] : [e.path],
  )
  const insightOf = (path: string) => done.get(path)?.insight ?? kept.get(path)
  const evals = all.flatMap((e) => insightOf(e.path) ?? [])
  const headlineInput: HeadlineInput = {
    call: 'headline',
    tally: {
      ...suite.tally,
      total: Object.values(suite.tally).reduce((a, b) => a + b, 0) - suite.tally.errors,
      unit: 'results',
    },
    evals: all.map((e) => ({
      path: e.path,
      name: e.template ?? e.name,
      verdict:
        e.outcome === 'infra_error'
          ? 'infra error'
          : e.outcome === 'pass' && isStudy(e.cells ?? [])
            ? 'not gated'
            : e.outcome,
      answer: insightOf(e.path)?.answer?.text ?? null,
    })),
  }
  const headlineModel = modelHeadlineInput(headlineInput)
  const askHeadline = async (retry?: string[]): Promise<HeadlineOutput> => {
    const out = (await ask(
      o,
      'headline',
      headlineSchema,
      HEADLINE_PROMPT,
      retry ? { ...headlineModel.input, retry } : headlineModel.input,
      usage,
    )) as HeadlineOutput
    return { headline: out.headline && sentenceFrom(out.headline, headlineModel.ids) }
  }
  let headline: Sentence | null = prior?.headline ?? null
  const wantsHeadline = !headline && evals.length && (budget === null || admit(budget) === 'start')
  for (let tries = 1; wantsHeadline && !stopped() && tries <= 2; tries++) {
    try {
      headline = await checked(
        await askHeadline(),
        askHeadline,
        (out) => validateHeadline(out, headlineInput),
        validation,
      )
      break
    } catch {}
  }
  const { reasoningTokens, ...tokens } = usage
  return {
    kind: 'reeval-insights',
    schemaVersion: 1,
    runId: o.record.runId,
    model: o.model.name,
    promptVersion: insightsPromptVersion(),
    factsHash: factsHash(suite),
    createdAt: new Date().toISOString(),
    usage: { ...tokens, ...(reasoningTokens ? { reasoningTokens } : {}), costUsd: null },
    ...(o.maxTokens !== undefined
      ? {
          budget: {
            maxTokens: o.maxTokens,
            skipped: ordered.flatMap((e) => (skipped.has(e.path) ? [e.path] : [])),
          },
        }
      : {}),
    ...(failed.size
      ? {
          failed: ordered.flatMap((e) =>
            failed.has(e.path) ? [{ evalId: e.path, error: message(failed.get(e.path)) }] : [],
          ),
        }
      : {}),
    ...(left.length ? { stopped: { signal: o.stopSignal?.() ?? 'SIGINT', skipped: left } } : {}),
    headline,
    evals,
    remarks: [
      ...(prior?.remarks ?? []),
      ...all.flatMap((e) =>
        (done.get(e.path)?.remarks ?? []).map(
          (r): Remark => ({ ...r, firstSeenRun: o.record.runId }),
        ),
      ),
    ],
    validation,
  }
}

/** The evals a document lists as unfinished: stopped, failed or skipped by the budget. */
export function unfinishedEvals(doc: RunInsights): Set<string> {
  return new Set([
    ...(doc.stopped?.skipped ?? []),
    ...(doc.failed ?? []).map((f) => f.evalId),
    ...(doc.budget?.skipped ?? []),
  ])
}
