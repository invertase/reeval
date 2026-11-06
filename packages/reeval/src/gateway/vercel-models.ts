// reeval's own calls on `vercel()`: the judge's decision model and the language model analysis,
// questions and captures call, at `AI_GATEWAY_BASE_URL` when it names another gateway.
import { createGateway, type experimental_decide as decide, type LanguageModel } from 'ai'
import { vercelBaseUrl } from './vercel.ts'

type DecisionModel = Parameters<typeof decide>[0]['model']

/**
 * Where the AI SDK's gateway provider calls under Vercel's origin (`createGateway`'s default
 * `baseURL`, `https://ai-gateway.vercel.sh/v4/ai`): a gateway at `AI_GATEWAY_BASE_URL` serves the
 * same path under its own.
 */
export const VERCEL_AI_SDK_PATH = '/v4/ai'

/** The AI SDK's gateway provider at `AI_GATEWAY_BASE_URL`, or undefined for Vercel's own. */
function provider(env: NodeJS.ProcessEnv) {
  const base = vercelBaseUrl(env)
  return base ? createGateway({ baseURL: `${base}${VERCEL_AI_SDK_PATH}` }) : undefined
}

/** `model` as a decision model on `vercel()`: by name on Vercel's own API, which `ai` resolves. */
export const vercelDecisionModel = (model: string, env = process.env): DecisionModel =>
  provider(env)?.decisionModel(model) ?? model

/** `model` as a language model on `vercel()`: by name on Vercel's own API, which `ai` resolves. */
export const vercelLanguageModel = (model: string, env = process.env): LanguageModel =>
  provider(env)?.languageModel(model) ?? model
