// The analysis model: a language model, routed like the judge (the first gateway in the config's
// list that serves it; with no list, its provider's own key). Evaluation models (typesafe-ai/*)
// score yes/no questions and can't write one.
import { generateText, type LanguageModel, Output } from 'ai'
import { analysisModelOf } from '../config.ts'
import { UsageError } from '../errors.ts'
import { gatewayScope, resolveModelGateway } from '../gateway/models.ts'
import { openRouterFallbacks, openRouterLanguageModel } from '../gateway/openrouter-models.ts'
import {
  type VertexSettings,
  vertexLanguageModel,
  vertexSettings,
  vertexSettingsIn,
} from '../gateway/vertex.ts'
import { isFakeJudge, judgeRoute } from '../judge/index.ts'
import type { FakeAnalysisModel, GatewayName, JudgeModel, ResolvedConfig } from '../types.ts'
import type { Digest } from './digest.ts'
import { type AnalysisOutput, analysisSchema, SYSTEM_PROMPT } from './schema.ts'

export type ResolvedAnalysisModel = {
  name: string
  route: 'direct' | 'gateway' | 'openrouter' | 'vertex' | 'fake'
  fake?: FakeAnalysisModel
  /** On OpenRouter, whether it may fail the call over to another upstream provider. */
  fallbacks?: boolean
  /** On vertex, the entry's project and regions. */
  vertex?: VertexSettings
}

export const isFake = (m: unknown): m is FakeAnalysisModel =>
  typeof m === 'object' && m !== null && (m as FakeAnalysisModel).kind === 'fake-analysis'

const isEvaluationModel = (model: string) => model.startsWith('typesafe-ai/')

/**
 * The model reeval falls back to for analysis and compare questions: `analysis.model`, else
 * `judge` when it's a language model. `judge` is the run's judge model (a profile's over the
 * config's); the config's when none is given.
 */
function fallbackModel(
  config: ResolvedConfig,
  judge: JudgeModel | undefined = config.judge.model,
): string | FakeAnalysisModel | undefined {
  const model = analysisModelOf(config)
  if (model !== undefined) return model
  return typeof judge === 'string' && !isEvaluationModel(judge) ? judge : undefined
}

/** ` (the judge, typesafe-ai/jev-1.14.0, is an evaluation model: it scores yes/no questions and can't <task>)`, when it is one. */
function judgeAside(judge: JudgeModel | undefined, task: string): string {
  if (typeof judge !== 'string' && !isFakeJudge(judge)) return ''
  return ` (the judge, ${isFakeJudge(judge) ? 'a fake judge' : judge}, is an evaluation model: it scores yes/no questions and can't ${task})`
}

/** Which model analyses: `analysis.model`, else the judge's when it's a language model. */
export function analysisModelName(config: ResolvedConfig): string | FakeAnalysisModel {
  const model = fallbackModel(config)
  if (model !== undefined) return model
  throw new UsageError(
    `reeval analyze needs a language model. Set analysis: { model: 'google/gemini-3.8-flash' } in ${config.file}${judgeAside(config.judge.model, 'write an analysis')}, or run reeval analyze --context to hand the digest to your own coding agent.`,
  )
}

/**
 * The plan's name for the model a question without its own is answered by; null when none.
 * `judge` is the run's judge model.
 */
export function questionModelLabel(
  config: ResolvedConfig,
  judge: JudgeModel | undefined = config.judge.model,
): string | null {
  const model = fallbackModel(config, judge)
  if (model === undefined) return null
  return isFake(model) ? 'fake' : model
}

/**
 * The model that answers a question: its own, else the fallback, with `judge` the run's judge
 * model. Throws a UsageError (exit 2) when that's missing or an evaluation model.
 */
export function questionModel(
  config: ResolvedConfig,
  question: { question: string; model?: string; across?: unknown },
  where: string,
  judge: JudgeModel | undefined = config.judge.model,
): string | FakeAnalysisModel {
  if (question.model !== undefined) return question.model
  const task = question.across !== undefined ? 'pick between two attempts' : 'answer in words'
  const model = fallbackModel(config, judge)
  const fix = `give the question its own, { question: '…', model: 'google/gemini-3.8-flash' }, or set question: { model } on its group or eval`
  if (model === undefined) {
    throw new UsageError(
      `questions "${question.question}" (${where}) needs a language model to answer it. Set analysis: { model: 'google/gemini-3.8-flash' } in ${config.file}${judgeAside(judge, task)}, or ${fix}.`,
    )
  }
  if (typeof model === 'string' && isEvaluationModel(model)) {
    throw new UsageError(
      `questions "${question.question}" (${where}) would be answered by analysis.model in ${config.file}, "${model}", an evaluation model: it scores yes/no questions and can't ${task}. Use a language model, e.g. 'google/gemini-3.8-flash', or ${fix}.`,
    )
  }
  return model
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
  const scope = gatewayScope(config)
  const gateway = resolveModelGateway(model, undefined, scope, 'analysis.model')
  try {
    const route = judgeRoute(model, process.env, 'analysis model', gateway).kind
    return {
      name: model,
      route,
      ...(route === 'openrouter' ? { fallbacks: openRouterFallbacks(scope.gateways) } : {}),
      ...(route === 'vertex' ? { vertex: vertexSettingsIn(scope.gateways) } : {}),
    }
  } catch (error) {
    throw new UsageError(
      `${(error as Error).message} Or run reeval analyze --context, which needs no key.`,
    )
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

/**
 * The provider's own model for a direct route, the AI Gateway's by name on vercel, OpenRouter's
 * on openrouter, or Vertex AI's on vertex.
 */
export async function providerModel(model: ResolvedAnalysisModel): Promise<LanguageModel> {
  if (model.route === 'gateway') return model.name
  if (model.route === 'openrouter') return openRouterLanguageModel(model.name, !!model.fallbacks)
  if (model.route === 'vertex') {
    return vertexLanguageModel(model.name, model.vertex ?? vertexSettings())
  }
  const provider = model.name.slice(0, model.name.indexOf('/'))
  const id = model.name.slice(provider.length + 1)
  switch (provider) {
    case 'anthropic':
      return (await import('@ai-sdk/anthropic')).anthropic(id)
    case 'google':
      return (await import('@ai-sdk/google')).google(id)
    case 'openai':
      return (await import('@ai-sdk/openai')).openai(id)
    default:
      return model.name
  }
}

/** What a host model takes from its gateway's entry: OpenRouter's fallbacks, Vertex's project and regions. */
export type HostModelSettings = { fallbacks?: boolean; vertex?: VertexSettings }

/** The language model `name` is on `gateway`, checked for its key: what the judge's route says. */
export function hostModel(
  name: string,
  gateway: GatewayName | undefined,
  what: string,
  { fallbacks = false, vertex }: HostModelSettings = {},
): Promise<LanguageModel> {
  const route = judgeRoute(name, process.env, what, gateway).kind
  return providerModel({
    name,
    route,
    ...(route === 'openrouter' ? { fallbacks } : {}),
    ...(route === 'vertex' && vertex ? { vertex } : {}),
  })
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
