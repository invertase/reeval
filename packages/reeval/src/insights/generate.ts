// A run's insights from its record: per eval, one classification call (the name read first, and
// skipped when the classification is cached) and one insights call on its scoped facts, then one
// headline call for the run, each checked by the validator. A sentence the banned-word lint
// refuses is asked for once more, then dropped. `maxTokens` is spent on the evals most worth
// explaining first (`priority.ts`), each reserving an estimate before it starts (`budget.ts`);
// once the next one can't fit, no eval's calls start, and those in flight finish. Nothing here
// reads or changes a verdict: the facts are final before any call starts.
import { generateText, type LanguageModel, NoObjectGeneratedError, Output } from 'ai'
import type { z } from 'zod'
import { cannedModel, providerModel, type ResolvedAnalysisModel } from '../analysis/model.ts'
import type { RunRecord } from '../history/types.ts'
import type { FakeInsights } from '../types.ts'
import { slotsOf } from '../ui/layout.ts'
import type { EvalInsight, Job, RunInsights, Sentence } from '../view/insights.ts'
import { type EvalResult, type SuiteResult, suiteResult } from '../view/suite.ts'
import { admit, ledger, reserve, settle } from './budget.ts'
import type { Classified, ClassifyCache } from './classify.ts'
import { factsHash } from './hash.ts'
import {
  attemptTexts,
  classificationKey,
  evalInput,
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
import {
  CLASSIFY_PROMPT,
  type ClassificationOutput,
  classificationSchema,
  HEADLINE_PROMPT,
  type HeadlineOutput,
  headlineSchema,
  INSIGHTS_PROMPT,
  INSIGHTS_PROMPT_VERSION,
  type InsightsOutput,
  insightsSchema,
} from './schema.ts'
import { type Checked, type Drop, validateEvalInsights, validateHeadline } from './validate.ts'

export type InsightOptions = {
  record: RunRecord
  /** The run's folder, for failed attempts' transcripts; null to send none. */
  runDir: string | null
  model: ResolvedAnalysisModel
  maxOutputTokens: number
  /** Evals asked about at once. */
  concurrency?: number
  /** Tokens (in and out) over every call; once spent, no eval's calls start. Default: no cap. */
  maxTokens?: number
  /** Classifications already made, by key; none to classify every eval. */
  cache?: ClassifyCache
  /** Stops every call: the run gave up waiting. */
  signal?: AbortSignal
  /** Each call's tokens as it returns. */
  onUsage?: (call: CallUsage) => void
}

type Usage = { inputTokens: number; outputTokens: number; reasoningTokens: number }
type Call = 'classify' | 'insights' | 'headline'

/** One call's tokens: `eval` is its eval's path, or null for the headline. */
export type CallUsage = { call: Call; eval: string | null } & Usage
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

async function ask<S extends z.ZodType>(
  o: InsightOptions,
  call: Call,
  schema: S,
  system: string,
  input: ModelInput,
  usage: Usage,
): Promise<z.infer<S>> {
  type CallUsage = {
    inputTokens?: number
    outputTokens?: number
    outputTokenDetails?: { reasoningTokens?: number }
  }
  const count = (u: CallUsage | undefined) => {
    const used: Usage = {
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
      reasoningTokens: u?.outputTokenDetails?.reasoningTokens ?? 0,
    }
    usage.inputTokens += used.inputTokens
    usage.outputTokens += used.outputTokens
    usage.reasoningTokens += used.reasoningTokens
    o.onUsage?.({ call, eval: input.call === 'headline' ? null : input.eval.path, ...used })
  }
  const once = async () =>
    generateText({
      model: await languageModel(o.model, call, input, o.signal),
      system,
      prompt: JSON.stringify(input),
      output: Output.object({ schema, name: call }),
      temperature: 0.2,
      maxOutputTokens: o.maxOutputTokens,
      maxRetries: 3,
      ...(o.signal ? { abortSignal: o.signal } : {}),
    })
  let result: Awaited<ReturnType<typeof once>>
  try {
    result = await once()
  } catch (error) {
    // `maxRetries` retries the API's errors only; a reply that isn't the schema's JSON is asked
    // for once more, so one bad reply among a run's calls doesn't lose the others.
    if (!NoObjectGeneratedError.isInstance(error)) throw error
    count(error.usage)
    result = await once()
  }
  count(result.usage)
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

async function evalInsight(
  o: InsightOptions,
  e: EvalResult,
  usage: Usage,
  counts: Counts,
): Promise<EvalInsight> {
  const base = await evalInput(o.record, o.runDir, e)
  const key = classificationKey(o.record, e, o.model.name, INSIGHTS_PROMPT_VERSION)
  const classified = (await o.cache?.get(key)) ?? (await classify(o, base, usage))
  if (o.cache) await o.cache.set(key, classified).catch(() => {})
  const { job, subject } = classified
  const slots = slotsOf(job, e)
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
        INSIGHTS_PROMPT,
        retry ? { ...model.input, retry } : model.input,
        usage,
      )) as InsightsOutput,
      model.ids,
    )
  const texts = attemptTexts(o.record, e)
  const sentences = await checked(
    await askInsights(),
    askInsights,
    (out) => validateEvalInsights(out, input, slots, texts),
    counts,
  )
  return {
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
  }
}

/** The evals that get an insight, in the order the output prints them: none for a todo or a skip. */
export const insightEvals = (suite: SuiteResult) =>
  suite.files.flatMap((f) =>
    [...f.evals]
      .sort((a, b) => a.order - b.order)
      .filter((e) => !e.todo && e.outcome !== 'skipped'),
  )

/** An eval's insight, asked for once more when a call fails; its sentences counted only once it lands. */
async function evalInsightOnce(
  o: InsightOptions,
  e: EvalResult,
  usage: Usage,
  validation: Counts,
): Promise<EvalInsight> {
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

const addUsage = (to: Usage, from: Usage) => {
  to.inputTokens += from.inputTokens
  to.outputTokens += from.outputTokens
  to.reasoningTokens += from.reasoningTokens
}

/**
 * Classifies each eval, writes and checks its sentences, then the run's headline. Evals start in
 * priority order and are kept in output order; with `maxTokens`, those it didn't reach are listed
 * in `budget.skipped`. A call that fails twice, or the signal, rejects the whole run's insights.
 */
export async function generateInsights(o: InsightOptions): Promise<RunInsights> {
  const suite = suiteResult(o.record)
  const usage: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  const validation: Counts = { dropped: 0, regenerated: 0, drops: [] }
  const budget = o.maxTokens === undefined ? null : ledger(o.maxTokens)
  const ordered = insightEvals(suite)
  const skipped = new Set<string>()
  const done = new Map<string, EvalInsight>()
  const running = new Set<Promise<void>>()
  const concurrency = o.concurrency ?? 4
  const failure: { error?: unknown; failed: boolean } = { failed: false }
  for (const e of byPriority(ordered)) {
    let decision: 'start' | 'skip' = 'start'
    for (;;) {
      if (failure.failed) break
      if (running.size >= concurrency) {
        await Promise.race(running)
        continue
      }
      const next = budget ? admit(budget) : 'start'
      if (next !== 'wait') {
        decision = next
        break
      }
      await Promise.race(running)
    }
    if (failure.failed) break
    if (decision === 'skip') {
      skipped.add(e.path)
      continue
    }
    const held = budget ? reserve(budget) : 0
    const used: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
    const call: Promise<void> = evalInsightOnce(o, e, used, validation)
      .then((insight) => void done.set(e.path, insight))
      .catch((error) => {
        if (!failure.failed) Object.assign(failure, { failed: true, error })
      })
      .finally(() => {
        if (budget) settle(budget, held, spent(used))
        addUsage(usage, used)
        running.delete(call)
      })
    running.add(call)
  }
  await Promise.all(running)
  if (failure.failed) throw failure.error
  const evals = ordered.flatMap((e) => done.get(e.path) ?? [])
  const headlineInput: HeadlineInput = {
    call: 'headline',
    tally: {
      ...suite.tally,
      total: Object.values(suite.tally).reduce((a, b) => a + b, 0) - suite.tally.errors,
      unit: 'results',
    },
    evals: ordered.map((e) => ({
      path: e.path,
      name: e.template ?? e.name,
      verdict: e.outcome === 'infra_error' ? 'infra error' : e.outcome,
      answer: done.get(e.path)?.answer?.text ?? null,
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
  const headline: Sentence | null =
    evals.length && (budget === null || admit(budget) === 'start')
      ? await checked(
          await askHeadline(),
          askHeadline,
          (out) => validateHeadline(out, headlineInput),
          validation,
        )
      : null
  const { reasoningTokens, ...tokens } = usage
  return {
    kind: 'reeval-insights',
    schemaVersion: 1,
    runId: o.record.runId,
    model: o.model.name,
    promptVersion: INSIGHTS_PROMPT_VERSION,
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
    headline,
    evals,
    remarks: [],
    validation,
  }
}
