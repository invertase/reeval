// The models reeval calls itself on OpenRouter (the judge, analysis, compare questions and
// captures), through OpenRouter's own AI SDK package with `OPENROUTER_API_KEY`. `fallbacks` on
// `openrouter()` decides whether OpenRouter may fail a call over to another upstream provider.
import type { experimental_decide, LanguageModel } from 'ai'
import type { GatewayDescriptor } from '../types.ts'
import { OPENROUTER_KEY } from './openrouter.ts'

/** Whether OpenRouter may fail over, from the run's gateway list: off unless `fallbacks: true`. */
export const openRouterFallbacks = (gateways: readonly GatewayDescriptor[]): boolean =>
  gateways.some((g) => g.kind === 'openrouter' && g.fallbacks === true)

async function provider() {
  const { createOpenRouter } = await import('@openrouter/ai-sdk-provider')
  return createOpenRouter({ apiKey: process.env[OPENROUTER_KEY] })
}

/** A language model on OpenRouter's Chat Completions API. */
export async function openRouterLanguageModel(
  id: string,
  fallbacks: boolean,
): Promise<LanguageModel> {
  return (await provider()).chat(id, { provider: { allow_fallbacks: fallbacks } })
}

type DecisionModel = Parameters<typeof experimental_decide>[0]['model']

/**
 * A decision model on OpenRouter's Decisions API, for the judge. The package implements the AI
 * SDK's earlier evaluation-model interface, which `decide` still takes; its state type predates
 * file parts, hence the cast.
 */
export async function openRouterDecisionModel(
  id: string,
  fallbacks: boolean,
): Promise<DecisionModel> {
  const model = (await provider()).evaluationModel(id, { provider: { allow_fallbacks: fallbacks } })
  return model as unknown as DecisionModel
}

/** The upstream provider and cost a call's `providerMetadata.openrouter` names, as a verdict's fields. */
export function openRouterBilling(providerMetadata: unknown): {
  upstream?: string
  costUsd?: number
} {
  const meta = (
    providerMetadata as { openrouter?: { provider?: unknown; usage?: { cost?: unknown } } }
  )?.openrouter
  const upstream = typeof meta?.provider === 'string' && meta.provider ? meta.provider : undefined
  const cost = meta?.usage?.cost
  return {
    ...(upstream ? { upstream } : {}),
    ...(typeof cost === 'number' && Number.isFinite(cost) ? { costUsd: cost } : {}),
  }
}
