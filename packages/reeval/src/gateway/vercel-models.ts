// reeval's own calls on `vercel()`: the judge's decision model and the language model analysis,
// questions and captures call, at `AI_GATEWAY_BASE_URL` when it names another gateway.
import { createGateway, type experimental_decide as decide, type LanguageModel } from 'ai'
import { hostEnv } from '../secrets-file.ts'
import { VERCEL_KEY, vercelBaseUrl } from './vercel.ts'

type DecisionModel = Parameters<typeof decide>[0]['model']

/**
 * Where the AI SDK's gateway provider calls under Vercel's origin (`createGateway`'s default
 * `baseURL`, `https://ai-gateway.vercel.sh/v4/ai`): a gateway at `AI_GATEWAY_BASE_URL` serves the
 * same path under its own.
 */
export const VERCEL_AI_SDK_PATH = '/v4/ai'

/**
 * The AI SDK's gateway provider at `AI_GATEWAY_BASE_URL` or with a held brokered key's value, or
 * undefined for Vercel's own with the environment's credential, which `ai` resolves by name.
 */
function provider(env: NodeJS.ProcessEnv) {
  const base = vercelBaseUrl(env)
  const held = hostEnv(env)[VERCEL_KEY]
  const apiKey = held !== env[VERCEL_KEY] ? held : undefined
  if (!base && !apiKey) return undefined
  return createGateway({
    ...(base ? { baseURL: `${base}${VERCEL_AI_SDK_PATH}` } : {}),
    ...(apiKey ? { apiKey } : {}),
  })
}

/** `model` as a decision model on `vercel()`: by name on Vercel's own API, which `ai` resolves. */
export const vercelDecisionModel = (model: string, env = process.env): DecisionModel =>
  provider(env)?.decisionModel(model) ?? model

/** `model` as a language model on `vercel()`: by name on Vercel's own API, which `ai` resolves. */
export const vercelLanguageModel = (model: string, env = process.env): LanguageModel =>
  provider(env)?.languageModel(model) ?? model
