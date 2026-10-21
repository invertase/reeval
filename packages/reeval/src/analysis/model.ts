// The analysis model: a language model, routed like the judge (a provider key goes direct, else
// the AI Gateway). Evaluation models (typesafe-ai/*) score yes/no questions and can't write one.
import { generateText, type LanguageModel, Output } from 'ai'
import { analysisModelOf } from '../config.ts'
import { UsageError } from '../errors.ts'
import { checkModelString, isFakeJudge, judgeCredentials, judgeRoute } from '../judge/index.ts'
import type { FakeAnalysisModel, ResolvedConfig } from '../types.ts'
import type { Digest } from './digest.ts'
import { type AnalysisOutput, analysisSchema, SYSTEM_PROMPT } from './schema.ts'

export type ResolvedAnalysisModel = {
  name: string
  route: 'direct' | 'gateway' | 'fake'
  fake?: FakeAnalysisModel
}

export const isFake = (m: unknown): m is FakeAnalysisModel =>
  typeof m === 'object' && m !== null && (m as FakeAnalysisModel).kind === 'fake-analysis'

const isEvaluationModel = (model: string) => model.startsWith('typesafe-ai/')

/** `reeval analyze`'s model: `analysis.model`, else the judge's when it's a language model. */
function defaultModel(config: ResolvedConfig): string | FakeAnalysisModel | undefined {
  const model = analysisModelOf(config)
  if (model !== undefined) return model
  const judge = config.judge.model
  return typeof judge === 'string' && !isEvaluationModel(judge) ? judge : undefined
}

/** ` (the judge, typesafe-ai/jev-1.14.0, is an evaluation model: it scores yes/no questions and can't <task>)`, when it is one. */
function judgeAside(config: ResolvedConfig, task: string): string {
  const judge = config.judge.model
  if (typeof judge !== 'string' && !isFakeJudge(judge)) return ''
  return ` (the judge, ${isFakeJudge(judge) ? 'a fake judge' : judge}, is an evaluation model: it scores yes/no questions and can't ${task})`
}

/** Which model analyses: `analysis.model`, else the judge's when it's a language model. */
export function analysisModelName(config: ResolvedConfig): string | FakeAnalysisModel {
  const model = defaultModel(config)
  if (model !== undefined) return model
  throw new UsageError(
    `reeval analyze needs a language model. Set analysis: { model: 'google/gemini-3.8-flash' } in ${config.file}${judgeAside(config, 'write an analysis')}, or run reeval analyze --context to hand the digest to your own coding agent.`,
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
  const fix = `give the question its own, { question: '…', model: 'google/gemini-3.8-flash' }, or set question: { model } on its group or eval`
  if (model === undefined) {
    throw new UsageError(
      `compare.questions "${question.question}" (${where}) needs a language model to answer it. Set analysis: { model: 'google/gemini-3.8-flash' } in ${config.file}${judgeAside(config, 'pick between two attempts')}, or ${fix}.`,
    )
  }
  if (typeof model === 'string' && isEvaluationModel(model)) {
    throw new UsageError(
      `compare.questions "${question.question}" (${where}) would be answered by analysis.model in ${config.file}, "${model}", an evaluation model: it scores yes/no questions and can't pick between two attempts. Use a language model, e.g. 'google/gemini-3.8-flash', or ${fix}.`,
    )
  }
  return model
}

/**
 * The variable `analysis.model` is missing when it's a provider model with no credential set: its
 * provider's own key, else the AI Gateway's. Null when one is set, or for any other model.
 */
export function missingAnalysisKey(
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const model = analysisModelOf(config)
  if (typeof model !== 'string' || isEvaluationModel(model) || checkModelString(model)) return null
  const keys = judgeCredentials(model)
  return keys.some((k) => env[k]) ? null : (keys[0] ?? null)
}

/** Checks the model and its credentials before any work; throws a UsageError (exit 2). */
export function resolveAnalysisModel(config: ResolvedConfig): ResolvedAnalysisModel {
  const model = analysisModelName(config)
  if (isFake(model)) return { name: 'fake', route: 'fake', fake: model }
  if (isEvaluationModel(model)) {
    throw new UsageError(
      `analysis.model in ${config.file} is "${model}", an evaluation model: it scores yes/no questions and can't write an analysis. Use a language model, e.g. 'google/gemini-3.8-flash'.`,
    )
  }
  try {
    return { name: model, route: judgeRoute(model).kind }
  } catch (error) {
    const message = (error as Error).message.replace('judge model', 'analysis model')
    throw new UsageError(`${message} Or run reeval analyze --context, which needs no key.`)
  }
}

/**
 * A language model that answers `text`, through the AI SDK's own parsing, or throws `error`.
 * With `countTokens`, it reports a token per 4 characters of its prompt and its answer, so a
 * token budget applies to it as it would to a real model; otherwise it reports none.
 */
export function cannedModel(
  answer: { text: string } | { error: string },
  countTokens = false,
): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId: 'fake-analysis',
    supportedUrls: {},
    doGenerate: async (options) => {
      if ('error' in answer) throw new Error(answer.error)
      const input = countTokens ? Math.ceil(JSON.stringify(options.prompt).length / 4) : 0
      let output = countTokens ? Math.ceil(answer.text.length / 4) : 0
      let text = answer.text
      // Counting, it stops at maxOutputTokens as a provider does: the reply cut off mid-way.
      const cut =
        countTokens && options.maxOutputTokens !== undefined && output > options.maxOutputTokens
      if (cut) {
        output = options.maxOutputTokens as number
        text = text.slice(0, output * 4)
      }
      return {
        content: [{ type: 'text', text }],
        finishReason: cut
          ? { unified: 'length', raw: 'max_tokens' }
          : { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: output, text: output, reasoning: 0 },
        },
        warnings: [],
        response: { modelId: 'fake-analysis' },
      }
    },
    doStream: async () => {
      throw new Error('the fake analysis model does not stream')
    },
  }
}

/** A language model that answers with the fake's output. */
function fakeModel(fake: FakeAnalysisModel, digest: Digest): LanguageModel {
  if (fake.output === undefined) {
    throw new Error('fakeAnalysis() has no output, so it has no analysis to return')
  }
  const output = typeof fake.output === 'function' ? fake.output(digest) : fake.output
  return cannedModel({ text: typeof output === 'string' ? output : JSON.stringify(output) })
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
