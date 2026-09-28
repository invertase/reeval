import { google } from '@ai-sdk/google'
import { experimental_evaluate as evaluate } from 'ai'
import { debugTrace } from '../debug/attempt.ts'
import type { JudgeModel, JudgeOptions } from '../types.ts'
import { type JudgeState, judgeRoute } from './index.ts'

type EvaluationModel = Parameters<typeof evaluate>[0]['model']

/** See `judgeRoute`: a known provider's own package when its key is set, else the AI Gateway. */
async function resolveModel(
  model: Exclude<JudgeModel, { kind: 'fake-judge' }>,
): Promise<EvaluationModel> {
  if (typeof model !== 'string') return model as EvaluationModel
  const route = judgeRoute(model)
  if (route.kind === 'gateway') return model
  const id = model.slice(route.provider.length + 1)
  if (route.provider === 'google') return google.evaluationModel(id)
  const { typeSafeAi } = await import('@ai-sdk/typesafe-ai')
  return typeSafeAi.evaluationModel(id)
}

export async function scoreWithModel(
  model: Exclude<JudgeModel, { kind: 'fake-judge' }>,
  question: string,
  state: JudgeState,
  providerOptions: JudgeOptions['providerOptions'],
  signal: AbortSignal,
): Promise<{ score: number; resolvedModel: string | undefined }> {
  const result = await evaluate({
    model: await resolveModel(model),
    state,
    questions: { answer: { type: 'boolean', instructions: question } },
    providerOptions,
    abortSignal: signal,
    // reeval retries itself, with longer backoff, and records each retry with the verdict.
    maxRetries: 0,
  })
  const { answers, usage, warnings, response, providerMetadata } = result
  debugTrace(
    'judge',
    'provider-response',
    { answers, usage, warnings, response, providerMetadata },
    'judge provider response',
  )
  return { score: result.answers.answer.probability, resolvedModel: result.response?.modelId }
}
