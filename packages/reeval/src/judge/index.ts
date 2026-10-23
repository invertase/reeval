import { VERCEL_KEY, VERCEL_OIDC, vercelCredentialProblem } from '../gateway/vercel.ts'
import type { JudgeRetry } from '../history/types.ts'
import { badCharacterAt } from '../redact.ts'
import type {
  FakeJudgeModel,
  GatewayName,
  JudgeModel,
  JudgeOptions,
  JudgeState,
  Verdict,
} from '../types.ts'
import { JUDGE_RETRY, type RetryPolicy, withRetries } from './retry.ts'

/** The judge the docs recommend, pinned so a model update never silently moves scores. */
export const RECOMMENDED_JUDGE_MODEL = 'typesafe-ai/jev-1.14.0'
/** The language model `reeval init` sets as `analysis.model` and the docs recommend for insights. */
export const RECOMMENDED_ANALYSIS_MODEL = 'google/gemini-3.8-flash'
export const DEFAULT_THRESHOLD = 0.8

const GATEWAY_KEYS = [VERCEL_KEY, VERCEL_OIDC]

/**
 * Providers reeval calls directly, through their own AI SDK package, when their key is set. The
 * direct key wins over a Gateway credential; any other prefix goes through the AI Gateway.
 */
export const DIRECT_PROVIDERS: Record<string, { key: string; pkg: string; name: string }> = {
  anthropic: { key: 'ANTHROPIC_API_KEY', pkg: '@ai-sdk/anthropic', name: 'Anthropic' },
  google: { key: 'GOOGLE_GENERATIVE_AI_API_KEY', pkg: '@ai-sdk/google', name: 'Google' },
  openai: { key: 'OPENAI_API_KEY', pkg: '@ai-sdk/openai', name: 'OpenAI' },
  'typesafe-ai': { key: 'TYPESAFE_AI_API_KEY', pkg: '@ai-sdk/typesafe-ai', name: 'TypeSafe AI' },
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

/**
 * Environment variables a model needs, as alternatives in the order reeval prefers them: its
 * provider's own key, then the Gateway's. Any one of them is enough. On a gateway from the
 * config's list, only that gateway's.
 */
export function judgeCredentials(model: string | FakeJudgeModel, gateway?: GatewayName): string[] {
  if (isFakeJudge(model)) return []
  const direct = DIRECT_PROVIDERS[providerOf(model)]
  if (gateway === 'direct') return direct ? [direct.key] : []
  if (gateway === 'vercel') return GATEWAY_KEYS
  return direct ? [direct.key, ...GATEWAY_KEYS] : GATEWAY_KEYS
}

/**
 * The keys that would work for a model, each with its route: `ANTHROPIC_API_KEY (to call
 * Anthropic directly) or AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN (to go through the Vercel AI
 * Gateway)`. A prefix with no direct route says the Gateway is its only one. On a gateway from
 * the config's list, only that gateway's keys.
 */
export function modelKeyOptions(model: string, on?: GatewayName): string {
  const prefix = providerOf(model)
  const direct = DIRECT_PROVIDERS[prefix]
  const gateway = GATEWAY_KEYS.join(' or ')
  if (on === 'vercel') return `${gateway} (for vercel())`
  if (on === 'direct' && direct) return `${direct.key} (for direct())`
  if (direct) {
    return `${direct.key} (to call ${direct.name} directly) or ${gateway} (to go through the Vercel AI Gateway)`
  }
  return `${gateway} (to go through the Vercel AI Gateway, the only route for ${prefix}/* models; reeval calls ${Object.keys(
    DIRECT_PROVIDERS,
  )
    .map((p) => `${p}/*`)
    .join(', ')} directly)`
}

/**
 * The provider's own package when its key is set, else the Vercel AI Gateway when a Gateway
 * credential is set; on a gateway from the config's list, only that one. Throws, naming the
 * model, its prefix and every key that would work, when none is set, when the key it would send
 * has whitespace or a line break in it, or when Vercel's project token has expired.
 */
export function judgeRoute(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
  what = 'judge model',
  gateway?: GatewayName,
): JudgeRoute {
  const provider = providerOf(model)
  const direct = DIRECT_PROVIDERS[provider]
  const key = judgeCredentials(model, gateway).find((k) => env[k])
  if (key === undefined) {
    throw new Error(
      `No credentials for ${what} "${model}" (provider "${provider}"). Set ${modelKeyOptions(model, gateway)}, in the environment or .env.local.`,
    )
  }
  if (key === VERCEL_OIDC) {
    const expired = vercelCredentialProblem(env)
    if (expired) throw new Error(`${what} "${model}": ${expired}`)
  }
  const at = badCharacterAt(env[key] as string)
  if (at) {
    throw new Error(
      `${key} for ${what} "${model}" has whitespace or a line break in it at character ${at}. A key copied from a wrapped terminal line picks these up; set it again as one line.`,
    )
  }
  return direct && key === direct.key
    ? { kind: 'direct', provider, pkg: direct.pkg }
    : { kind: 'gateway' }
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
  const gateway = typeof options.gateway === 'object' ? options.gateway.kind : options.gateway
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
      () => scoreWithModel(model, question, state, options.providerOptions, signal, gateway),
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
    ...(gateway && typeof model === 'string' ? { gateway } : {}),
  }
  return { verdict, retries }
}
