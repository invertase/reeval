import { google } from '@ai-sdk/google'
import { experimental_evaluate as evaluate } from 'ai'
import type { JudgeModel, JudgeOptions } from '../types.ts'
import type { JudgeState } from './index.ts'

type EvaluationModel = Parameters<typeof evaluate>[0]['model']

/**
 * `google/<id>` uses the Google provider's evaluation adapter directly. Any other string
 * (e.g. `typesafe-ai/jev`) resolves through the AI SDK default provider, the AI Gateway.
 */
function resolveModel(model: Exclude<JudgeModel, { kind: 'fake-judge' }>): EvaluationModel {
  if (typeof model !== 'string') return model as EvaluationModel
  if (model.startsWith('google/')) return google.evaluationModel(model.slice('google/'.length))
  return model
}

export async function scoreWithModel(
  model: Exclude<JudgeModel, { kind: 'fake-judge' }>,
  question: string,
  state: JudgeState,
  providerOptions: JudgeOptions['providerOptions'],
  signal: AbortSignal,
): Promise<{ score: number; resolvedModel: string | undefined }> {
  const result = await evaluate({
    model: resolveModel(model),
    state,
    questions: { answer: { type: 'boolean', instructions: question } },
    providerOptions,
    abortSignal: signal,
  })
  return { score: result.answers.answer.probability, resolvedModel: result.response?.modelId }
}
