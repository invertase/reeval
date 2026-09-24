import type { FakeJudgeModel, JSONValue, JudgeModel, JudgeOptions, Verdict } from '../types.ts'

export const DEFAULT_JUDGE_MODEL = 'google/gemini-3.8-flash'
export const DEFAULT_THRESHOLD = 0.8

export type JudgeState = { [key: string]: JSONValue }

export const isFakeJudge = (m: unknown): m is FakeJudgeModel =>
  typeof m === 'object' && m !== null && (m as FakeJudgeModel).kind === 'fake-judge'

export function judgeModelName(model: JudgeModel): string {
  if (typeof model === 'string') return model
  if (isFakeJudge(model)) return 'fake'
  const m = model as { provider?: string; modelId?: string }
  return m.provider && m.modelId ? `${m.provider}/${m.modelId}` : 'custom'
}

/** Checks a model string's shape; returns an error message, or undefined when it's valid. */
export function checkModelString(model: string): string | undefined {
  if (model.includes('/')) return undefined
  return `Judge model "${model}" needs a provider prefix, e.g. "google/${model}" or "typesafe-ai/jev"`
}

/** Environment variables the judge model needs, as alternatives: any one of them is enough. */
export function judgeCredentials(model: string | FakeJudgeModel): string[] {
  if (isFakeJudge(model)) return []
  if (model.startsWith('google/')) return ['GOOGLE_GENERATIVE_AI_API_KEY']
  return ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN']
}

export async function runJudge(
  question: string,
  state: JudgeState,
  options: Required<Pick<JudgeOptions, 'model' | 'threshold'>> & JudgeOptions,
  signal: AbortSignal,
): Promise<Verdict> {
  const { model, threshold } = options
  let score: number
  if (isFakeJudge(model)) {
    score = model.score
  } else {
    if (typeof model === 'string') {
      const problem = checkModelString(model)
      if (problem) throw new Error(problem)
    }
    const { scoreWithModel } = await import('./model.ts')
    score = await scoreWithModel(model, question, state, options.providerOptions, signal)
  }
  return {
    verdict: score >= threshold ? 'pass' : 'fail',
    score,
    threshold,
    question,
    model: judgeModelName(model),
  }
}
