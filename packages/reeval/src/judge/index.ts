import type { JudgeRetry } from '../history/types.ts'
import type { FakeJudgeModel, JudgeModel, JudgeOptions, JudgeState, Verdict } from '../types.ts'
import { JUDGE_RETRY, type RetryPolicy, withRetries } from './retry.ts'

/** The judge the docs recommend, pinned so a model update never silently moves scores. */
export const RECOMMENDED_JUDGE_MODEL = 'typesafe-ai/jev-1.13.0'
export const DEFAULT_THRESHOLD = 0.8

const GATEWAY_KEYS = ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN']

/** Providers reeval calls directly, through their own AI SDK package, when their key is set. */
export const DIRECT_PROVIDERS: Record<string, { key: string; pkg: string }> = {
  google: { key: 'GOOGLE_GENERATIVE_AI_API_KEY', pkg: '@ai-sdk/google' },
  'typesafe-ai': { key: 'TYPESAFE_AI_API_KEY', pkg: '@ai-sdk/typesafe-ai' },
}

export type JudgeRoute = { kind: 'direct'; provider: string; pkg: string } | { kind: 'gateway' }

export type { JudgeState } from '../types.ts'

export const isFakeJudge = (m: unknown): m is FakeJudgeModel =>
  typeof m === 'object' && m !== null && (m as FakeJudgeModel).kind === 'fake-judge'

export function judgeModelName(model: JudgeModel): string {
  if (typeof model === 'string') return model
  if (isFakeJudge(model)) return 'fake'
  const m = model as { provider?: string; modelId?: string }
  return m.provider && m.modelId ? `${m.provider}/${m.modelId}` : 'custom'
}

/**
 * Checks a model string's shape; returns an error message naming it as `what` (with where it was
 * set), or undefined when it's valid.
 */
export function checkModelString(
  model: string,
  what = 'The judge model',
  examples = [RECOMMENDED_JUDGE_MODEL, `google/${model}`],
): string | undefined {
  if (model.includes('/')) return undefined
  return `${what} needs a provider prefix, e.g. ${examples.map((e) => `"${e}"`).join(' or ')} (got "${model}")`
}

const providerOf = (model: string) => model.slice(0, model.indexOf('/'))

/** Environment variables the judge model needs, as alternatives: any one of them is enough. */
export function judgeCredentials(model: string | FakeJudgeModel): string[] {
  if (isFakeJudge(model)) return []
  const direct = DIRECT_PROVIDERS[providerOf(model)]
  return direct ? [direct.key, ...GATEWAY_KEYS] : GATEWAY_KEYS
}

/**
 * A known provider's own package when its key is set, else the Vercel AI Gateway when a
 * Gateway credential is set. Throws, naming both, when neither is.
 */
export function judgeRoute(model: string, env: NodeJS.ProcessEnv = process.env): JudgeRoute {
  const provider = providerOf(model)
  const direct = DIRECT_PROVIDERS[provider]
  if (direct && env[direct.key]) return { kind: 'direct', provider, pkg: direct.pkg }
  if (GATEWAY_KEYS.some((k) => env[k])) return { kind: 'gateway' }
  const options = direct
    ? `Set ${direct.key} to call ${direct.pkg} directly, or AI_GATEWAY_API_KEY (or VERCEL_OIDC_TOKEN) to go through the Vercel AI Gateway, in the environment or .env.local.`
    : 'Set AI_GATEWAY_API_KEY (or VERCEL_OIDC_TOKEN) to go through the Vercel AI Gateway, in the environment or .env.local.'
  throw new Error(`No credentials for judge model "${model}". ${options}`)
}

/** A verdict plus the transient failures retried on the way to it. */
export type JudgeResult = { verdict: Verdict; retries: JudgeRetry[] }

/** Transient provider errors (429, 5xx, "high demand") are retried with backoff and recorded. */
export async function runJudge(
  question: string,
  state: JudgeState,
  options: Required<Pick<JudgeOptions, 'model' | 'threshold'>> & JudgeOptions,
  signal: AbortSignal,
  retry: RetryPolicy = JUDGE_RETRY,
): Promise<JudgeResult> {
  const { model, threshold } = options
  let score: number
  let resolvedModel: string | undefined
  let retries: JudgeRetry[] = []
  if (isFakeJudge(model)) {
    score = typeof model.score === 'function' ? model.score(state) : model.score
  } else {
    if (typeof model === 'string') {
      const problem = checkModelString(model)
      if (problem) throw new Error(problem)
    }
    const { scoreWithModel } = await import('./model.ts')
    const scored = await withRetries(
      () => scoreWithModel(model, question, state, options.providerOptions, signal),
      retry,
      signal,
    )
    ;({ score, resolvedModel } = scored.value)
    retries = scored.retries
  }
  const verdict: Verdict = {
    verdict: score >= threshold ? 'pass' : 'fail',
    score,
    threshold,
    question,
    model: judgeModelName(model),
    ...(resolvedModel ? { resolvedModel } : {}),
  }
  return { verdict, retries }
}
