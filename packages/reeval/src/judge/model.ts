import { experimental_decide as decide } from 'ai'
import { debugTrace } from '../debug/attempt.ts'
import { openRouterBilling, openRouterDecisionModel } from '../gateway/openrouter-models.ts'
import type { GatewayName, JudgeModel, JudgeOptions } from '../types.ts'
import {
  DIRECT_PROVIDERS,
  type JudgeState,
  judgeRoute,
  OPENROUTER_JUDGE_MODEL,
  RECOMMENDED_JUDGE_MODEL,
} from './index.ts'

type DecisionModel = Parameters<typeof decide>[0]['model']

/**
 * See `judgeRoute`: the provider's own package on direct, the AI Gateway on vercel, OpenRouter's
 * Decisions API on openrouter.
 */
async function resolveModel(
  model: Exclude<JudgeModel, { kind: 'fake-judge' }>,
  gateway: GatewayName | undefined,
  fallbacks: boolean,
): Promise<DecisionModel> {
  if (typeof model !== 'string') return model as DecisionModel
  const route = judgeRoute(model, process.env, 'judge model', gateway)
  if (route.kind === 'gateway') return model
  if (route.kind === 'openrouter') return openRouterDecisionModel(model, fallbacks)
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

/** The decision model reeval's `openai/*` judges call on OpenAI's Decisions API. */
const OPENAI_DECISION_MODEL = 'gpt-6-luna'

type ApiError = { message?: string; data?: { error?: { code?: string } } }

/**
 * reeval's sentence when the judge's route answers only decision models and `model` isn't one:
 * Vercel AI Gateway and OpenRouter refuse a language model as a judge, and OpenAI's Decisions API
 * answers only its decision model. Undefined for any other error.
 */
function judgeModelRefusal(
  model: string,
  gateway: GatewayName | undefined,
  error: unknown,
): string | undefined {
  const e = error as ApiError & { statusCode?: number }
  const provider = model.slice(0, model.indexOf('/'))
  if (
    gateway === 'openrouter' &&
    (/not a decision model/i.test(e?.message ?? '') || e?.statusCode === 404)
  ) {
    return `the judge model "${model}" isn't a decision model OpenRouter answers on its Decisions API (OpenRouter said: ${e.message}). Use a decision model on openrouter(), such as '${OPENROUTER_JUDGE_MODEL}'.`
  }
  if (gateway === 'vercel' && /is a language model, not a decision model/.test(e?.message ?? '')) {
    const direct = DIRECT_PROVIDERS[provider]
    const instead =
      provider === 'openai'
        ? `, or 'openai/${OPENAI_DECISION_MODEL}' pinned to direct() with judge: { gateway: 'direct' } on ${direct?.key}`
        : direct
          ? `, or pin this one to direct() with judge: { gateway: 'direct' } to call it on ${direct.key}`
          : ''
    return `the judge model "${model}" is a language model, and Vercel AI Gateway judges only with decision models. Use a decision model on vercel(), such as '${RECOMMENDED_JUDGE_MODEL}' or 'openai/${OPENAI_DECISION_MODEL}-decisions'${instead}.`
  }
  const id = model.slice(provider.length + 1)
  if (
    (gateway ?? 'direct') === 'direct' &&
    provider === 'openai' &&
    id !== OPENAI_DECISION_MODEL &&
    e?.data?.error?.code === 'model_not_found'
  ) {
    return `the judge model "${model}" isn't a decision model: reeval's openai/* judges call OpenAI's Decisions API, which answers with '${OPENAI_DECISION_MODEL}' (OpenAI said: ${e.message}). Use 'openai/${OPENAI_DECISION_MODEL}'.`
  }
  return undefined
}

export async function scoreWithModel(
  model: Exclude<JudgeModel, { kind: 'fake-judge' }>,
  question: string,
  state: JudgeState,
  providerOptions: JudgeOptions['providerOptions'],
  signal: AbortSignal,
  gateway?: GatewayName,
  fallbacks = false,
): Promise<{
  score: number
  resolvedModel: string | undefined
  upstream?: string
  costUsd?: number
}> {
  const resolved = await resolveModel(model, gateway, fallbacks)
  const result = await decide({
    model: resolved,
    state,
    questions: { answer: { type: 'boolean', instructions: question } },
    providerOptions,
    abortSignal: signal,
    // reeval retries itself, with longer backoff, and records each retry with the verdict.
    maxRetries: 0,
  }).catch((error: unknown) => {
    const refusal = typeof model === 'string' && judgeModelRefusal(model, gateway, error)
    throw refusal ? new Error(refusal, { cause: error }) : error
  })
  const { answers, usage, warnings, response, providerMetadata } = result
  debugTrace(
    'judge',
    'provider-response',
    { answers, usage, warnings, response, providerMetadata },
    'judge provider response',
  )
  return {
    score: result.answers.answer.probability,
    resolvedModel: result.response?.modelId,
    ...(gateway === 'openrouter' ? openRouterBilling(providerMetadata) : {}),
  }
}
