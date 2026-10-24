import { experimental_decide as decide } from 'ai'
import { debugTrace } from '../debug/attempt.ts'
import { type VertexSettings, vertexDecisionModel, vertexSettings } from '../gateway/vertex.ts'
import type { GatewayName, JudgeModel, JudgeOptions } from '../types.ts'
import { type JudgeState, judgeRoute } from './index.ts'

type DecisionModel = Parameters<typeof decide>[0]['model']

/** See `judgeRoute`: the provider's own package on direct, the AI Gateway on vercel, Vertex AI on vertex. */
async function resolveModel(
  model: Exclude<JudgeModel, { kind: 'fake-judge' }>,
  gateway: GatewayName | undefined,
  vertex: VertexSettings | undefined,
): Promise<DecisionModel> {
  if (typeof model !== 'string') return model as DecisionModel
  const route = judgeRoute(model, process.env, 'judge model', gateway)
  if (route.kind === 'gateway') return model
  if (route.kind === 'vertex') return vertexDecisionModel(model, vertex ?? vertexSettings())
  const id = model.slice(route.provider.length + 1)
  switch (route.provider) {
    case 'anthropic':
      return (await import('@ai-sdk/anthropic')).anthropic.decisionModel(id)
    case 'google':
      return (await import('@ai-sdk/google')).google.decisionModel(id)
    case 'openai':
      return (await import('@ai-sdk/openai')).openai.decisionModel(id)
    default:
      return (await import('@ai-sdk/typesafe-ai')).typeSafeAi.decisionModel(id)
  }
}

export async function scoreWithModel(
  model: Exclude<JudgeModel, { kind: 'fake-judge' }>,
  question: string,
  state: JudgeState,
  providerOptions: JudgeOptions['providerOptions'],
  signal: AbortSignal,
  gateway?: GatewayName,
  vertex?: VertexSettings,
): Promise<{ score: number; resolvedModel: string | undefined }> {
  const result = await decide({
    model: await resolveModel(model, gateway, vertex),
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
