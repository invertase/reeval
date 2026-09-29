// The analysis model: a language model, routed like the judge (a provider key goes direct, else
// the AI Gateway). Evaluation models (typesafe-ai/*) score yes/no questions and can't write one.
import { generateText, type LanguageModel, Output } from 'ai'
import { UsageError } from '../errors.ts'
import { isFakeJudge, judgeRoute } from '../judge/index.ts'
import type { FakeAnalysisModel, ResolvedConfig } from '../types.ts'
import type { Digest } from './digest.ts'
import { type AnalysisOutput, analysisSchema, SYSTEM_PROMPT } from './schema.ts'

export type ResolvedAnalysisModel = {
  name: string
  route: 'direct' | 'gateway' | 'fake'
  fake?: FakeAnalysisModel
}

const isFake = (m: unknown): m is FakeAnalysisModel =>
  typeof m === 'object' && m !== null && (m as FakeAnalysisModel).kind === 'fake-analysis'

const isEvaluationModel = (model: string) => model.startsWith('typesafe-ai/')

/** `analysis.model`, else the judge's when it's a language model; undefined when neither is. */
function defaultModel(config: ResolvedConfig): string | FakeAnalysisModel | undefined {
  const model = config.analysis.model
  if (model !== undefined) return model
  const judge = config.judge.model
  if (typeof judge === 'string' && !isEvaluationModel(judge)) return judge
  return undefined
}

/** ` (the judge, typesafe-ai/jev-1.13.0, is an evaluation model: it scores yes/no questions and can't <task>)`, when it is one. */
function judgeAside(config: ResolvedConfig, task: string): string {
  const judge = config.judge.model
  if (typeof judge !== 'string' && !isFakeJudge(judge)) return ''
  return ` (the judge, ${isFakeJudge(judge) ? 'a fake judge' : judge}, is an evaluation model: it scores yes/no questions and can't ${task})`
}

/** Who needs the analysis model: `reeval analyze`, or `analysis.agent` during `reeval run`. */
export type AnalysisUse = 'analyze' | 'agent'

/** Which model analyses: `analysis.model`, else the judge's when it's a language model. */
export function analysisModelName(
  config: ResolvedConfig,
  use: AnalysisUse = 'analyze',
): string | FakeAnalysisModel {
  const model = defaultModel(config)
  if (model !== undefined) return model
  throw new UsageError(
    `${use === 'agent' ? 'config.analysis.agent' : 'reeval analyze'} needs a language model. Set analysis: { model: 'google/gemini-3.8-flash' } in ${config.file}${judgeAside(config, 'write an analysis')}${use === 'agent' ? ', or turn agent off' : ', or run reeval analyze --context to hand the digest to your own coding agent'}.`,
  )
}

/** The plan's name for the model a compare question without its own is answered by; null when none. */
export function questionModelLabel(config: ResolvedConfig): string | null {
  const model = defaultModel(config)
  if (model === undefined) return null
  return isFake(model) ? 'fake' : model
}

/**
 * The model that answers a compare question: its own, else the analysis model. Throws a
 * UsageError (exit 2) when that's missing or an evaluation model.
 */
export function questionModel(
  config: ResolvedConfig,
  question: { question: string; model?: string },
  where: string,
): string | FakeAnalysisModel {
  if (question.model !== undefined) return question.model
  const model = defaultModel(config)
  const fix = `give the question its own, { question: '…', model: 'google/gemini-3.8-flash' }`
  if (model === undefined) {
    throw new UsageError(
      `compare.question "${question.question}" (${where}) needs a language model to answer it. Set analysis: { model: 'google/gemini-3.8-flash' } in ${config.file}${judgeAside(config, 'pick between two attempts')}, or ${fix}.`,
    )
  }
  if (typeof model === 'string' && isEvaluationModel(model)) {
    throw new UsageError(
      `compare.question "${question.question}" (${where}) would be answered by config.analysis.model "${model}", an evaluation model: it scores yes/no questions and can't pick between two attempts. Use a language model, e.g. 'google/gemini-3.8-flash', or ${fix}.`,
    )
  }
  return model
}

/** Checks the model and its credentials before any work; throws a UsageError (exit 2). */
export function resolveAnalysisModel(
  config: ResolvedConfig,
  use: AnalysisUse = 'analyze',
): ResolvedAnalysisModel {
  const model = analysisModelName(config, use)
  if (isFake(model)) return { name: 'fake', route: 'fake', fake: model }
  if (isEvaluationModel(model)) {
    throw new UsageError(
      `config.analysis.model "${model}" is an evaluation model: it scores yes/no questions and can't write an analysis. Use a language model, e.g. 'google/gemini-3.8-flash'.`,
    )
  }
  try {
    return { name: model, route: judgeRoute(model).kind }
  } catch (error) {
    const message = (error as Error).message.replace('judge model', 'analysis model')
    throw new UsageError(
      use === 'agent' ? message : `${message} Or run reeval analyze --context, which needs no key.`,
    )
  }
}

/** A language model that answers with the fake's output, through the AI SDK's own parsing. */
function fakeModel(fake: FakeAnalysisModel, digest: Digest): LanguageModel {
  if (fake.output === undefined) {
    throw new Error('fakeAnalysis() has no output, so reeval analyze has no answer to return')
  }
  const output = typeof fake.output === 'function' ? fake.output(digest) : fake.output
  const text = typeof output === 'string' ? output : JSON.stringify(output)
  return {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId: 'fake-analysis',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
      warnings: [],
      response: { modelId: 'fake-analysis' },
    }),
    doStream: async () => {
      throw new Error('the fake analysis model does not stream')
    },
  } as unknown as LanguageModel
}

async function languageModel(model: ResolvedAnalysisModel, digest: Digest): Promise<LanguageModel> {
  if (model.fake) return fakeModel(model.fake, digest)
  return providerModel(model)
}

/** The provider's own model for a direct route, else the AI Gateway's by name. */
export async function providerModel(model: ResolvedAnalysisModel): Promise<LanguageModel> {
  if (model.route === 'gateway') return model.name
  const provider = model.name.slice(0, model.name.indexOf('/'))
  const id = model.name.slice(provider.length + 1)
  if (provider === 'google') {
    const { google } = await import('@ai-sdk/google')
    return google(id)
  }
  return model.name
}

export type ModelAnswer = {
  output: AnalysisOutput
  resolvedModel: string | null
  usage: { inputTokens: number | null; outputTokens: number | null }
  latencyMs: number
}

export async function callAnalysisModel(
  model: ResolvedAnalysisModel,
  digest: Digest,
  prompt: string,
  maxOutputTokens: number,
): Promise<ModelAnswer> {
  const started = Date.now()
  const result = await generateText({
    model: await languageModel(model, digest),
    system: SYSTEM_PROMPT,
    prompt,
    output: Output.object({ schema: analysisSchema, name: 'analysis' }),
    temperature: 0.2,
    maxOutputTokens,
    maxRetries: 3,
  })
  return {
    output: result.output as AnalysisOutput,
    resolvedModel: result.response?.modelId ?? null,
    usage: {
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
    },
    latencyMs: Date.now() - started,
  }
}
