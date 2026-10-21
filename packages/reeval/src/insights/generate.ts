// A run's insights from its record: per eval, one classification call (the name read first) and
// one insights call on its scoped facts, then one headline call for the run, each checked by the
// validator. A sentence the banned-word lint refuses is asked for once more, then dropped. Nothing
// here reads or changes a verdict: the facts are final before any call starts.
import { generateText, type LanguageModel, Output } from 'ai'
import type { z } from 'zod'
import { cannedModel, providerModel, type ResolvedAnalysisModel } from '../analysis/model.ts'
import type { RunRecord } from '../history/types.ts'
import type { FakeInsights } from '../types.ts'
import { slotsOf } from '../ui/layout.ts'
import type { EvalInsight, Job, RunInsights, Sentence } from '../view/insights.ts'
import { type EvalResult, type SuiteResult, suiteResult } from '../view/suite.ts'
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
}

type Usage = { inputTokens: number; outputTokens: number }
type Call = 'classify' | 'insights' | 'headline'
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

async function languageModel(
  model: ResolvedAnalysisModel,
  call: Call,
  input: ModelInput,
): Promise<LanguageModel> {
  if (!model.fake) return providerModel(model)
  const insights = model.fake.insights
  if (insights === undefined) {
    throw new Error('fakeAnalysis() has no insights, so it has none to return')
  }
  if (typeof insights === 'object' && insights !== null && 'error' in insights) {
    return cannedModel({ error: insights.error })
  }
  const answer = typeof insights === 'function' ? insights(input) : insights
  return cannedModel({ text: JSON.stringify(fakePart(call, answer, input)) })
}

async function ask<S extends z.ZodType>(
  o: InsightOptions,
  call: Call,
  schema: S,
  system: string,
  input: ModelInput,
  usage: Usage,
): Promise<z.infer<S>> {
  const result = await generateText({
    model: await languageModel(o.model, call, input),
    system,
    prompt: JSON.stringify(input),
    output: Output.object({ schema, name: call }),
    temperature: 0.2,
    maxOutputTokens: o.maxOutputTokens,
    maxRetries: 3,
  })
  usage.inputTokens += result.usage?.inputTokens ?? 0
  usage.outputTokens += result.usage?.outputTokens ?? 0
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

async function evalInsight(
  o: InsightOptions,
  e: EvalResult,
  usage: Usage,
  counts: Counts,
): Promise<EvalInsight> {
  const base = await evalInput(o.record, o.runDir, e)
  const classified = (await ask(
    o,
    'classify',
    classificationSchema,
    CLASSIFY_PROMPT,
    modelInput({ call: 'classify', ...base }).input,
    usage,
  )) as ClassificationOutput
  const job: Job = classified.confidence === 'low' ? 'other' : classified.job
  const subject = {
    ...(classified.subject.tool ? { tool: classified.subject.tool } : {}),
    ...(classified.subject.change ? { change: classified.subject.change } : {}),
  }
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
      key: classificationKey(o.record, e, o.model.name, INSIGHTS_PROMPT_VERSION),
    },
    ...sentences,
  }
}

/** Runs `f` over `items`, at most `n` at once, keeping their order. */
async function mapLimit<T, R>(items: T[], n: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await f(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

/** The evals that get an insight, in the order the output prints them: none for a todo or a skip. */
export const insightEvals = (suite: SuiteResult) =>
  suite.files.flatMap((f) =>
    [...f.evals]
      .sort((a, b) => a.order - b.order)
      .filter((e) => !e.todo && e.outcome !== 'skipped'),
  )

/** Classifies each eval, writes and checks its sentences, then the run's headline. */
export async function generateInsights(o: InsightOptions): Promise<RunInsights> {
  const suite = suiteResult(o.record)
  const usage: Usage = { inputTokens: 0, outputTokens: 0 }
  const validation: Counts = { dropped: 0, regenerated: 0, drops: [] }
  const evals = await mapLimit(insightEvals(suite), o.concurrency ?? 4, (e) =>
    evalInsight(o, e, usage, validation),
  )
  const byPath = new Map(evals.map((x) => [x.evalId, x]))
  const headlineInput: HeadlineInput = {
    call: 'headline',
    tally: {
      ...suite.tally,
      total: Object.values(suite.tally).reduce((a, b) => a + b, 0),
      unit: 'results',
    },
    evals: insightEvals(suite).map((e) => ({
      path: e.path,
      name: e.template ?? e.name,
      verdict: e.outcome === 'infra_error' ? 'infra error' : e.outcome,
      answer: byPath.get(e.path)?.answer?.text ?? null,
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
  const headline: Sentence | null = await checked(
    await askHeadline(),
    askHeadline,
    (out) => validateHeadline(out, headlineInput),
    validation,
  )
  return {
    kind: 'reeval-insights',
    schemaVersion: 1,
    runId: o.record.runId,
    model: o.model.name,
    promptVersion: INSIGHTS_PROMPT_VERSION,
    factsHash: factsHash(suite),
    createdAt: new Date().toISOString(),
    usage: { ...usage, costUsd: null },
    headline,
    evals,
    remarks: [],
    validation,
  }
}
