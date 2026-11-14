// reeval's own calls on `vercel()`: the judge's decision model and the language model analysis,
// questions and captures call, made as `judgeRoute` settled them.
import { createGateway, type experimental_decide as decide, type LanguageModel } from 'ai'
import type { HostCall } from '../judge/index.ts'

type DecisionModel = Parameters<typeof decide>[0]['model']

/**
 * The AI SDK's gateway provider made with `call`, or undefined when it has nothing to set: then
 * `ai` resolves the model by name on Vercel's own API with the environment's credential.
 */
const provider = (call: HostCall) =>
  call.baseURL || call.apiKey || call.fetch ? createGateway(call) : undefined

/** `model` as a decision model on `vercel()`. */
export const vercelDecisionModel = (model: string, call: HostCall = {}): DecisionModel =>
  provider(call)?.decisionModel(model) ?? model

/** `model` as a language model on `vercel()`. */
export const vercelLanguageModel = (model: string, call: HostCall = {}): LanguageModel =>
  provider(call)?.languageModel(model) ?? model
