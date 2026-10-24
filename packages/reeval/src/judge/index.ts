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
 * Providers `direct()` calls, each through its own AI SDK package and key. Any other prefix needs
 * `vercel()` in the config's gateway list.
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
 * Environment variables a model needs on `gateway`, in the order reeval prefers them; any one is
 * enough. On direct, its provider's own key (none for a prefix reeval can't call directly); on
 * vercel, the Gateway's.
 */
export function judgeCredentials(
  model: string | FakeJudgeModel,
  gateway: GatewayName = 'direct',
): string[] {
  if (isFakeJudge(model)) return []
  if (gateway === 'vercel') return GATEWAY_KEYS
  const direct = DIRECT_PROVIDERS[providerOf(model)]
  return direct ? [direct.key] : []
}

/** The keys that would work for a model on `on`: `ANTHROPIC_API_KEY (for direct())`. */
export function modelKeyOptions(model: string, on: GatewayName = 'direct'): string {
  if (on === 'vercel') return `${GATEWAY_KEYS.join(' or ')} (for vercel())`
  const direct = DIRECT_PROVIDERS[providerOf(model)]
  return direct
    ? `${direct.key} (for direct())`
    : `vercel() in gateway (direct() calls only ${Object.keys(DIRECT_PROVIDERS)
        .map((p) => `${p}/*`)
        .join(', ')} models)`
}

/** The Vercel credential set in `env`, if any. */
export const setGatewayKey = (env: NodeJS.ProcessEnv) => GATEWAY_KEYS.find((k) => env[k])

/**
 * ` AI_GATEWAY_API_KEY is set, but …` when a Vercel credential is set and the model goes direct, so
 * a key that worked before reeval stopped falling back to the Gateway says how to use it.
 */
export function unusedGatewayKey(env: NodeJS.ProcessEnv, gateway: GatewayName = 'direct'): string {
  if (gateway !== 'direct') return ''
  const set = setGatewayKey(env)
  return set
    ? ` ${set} is set, but no gateway in the config uses it: add vercel() to gateway to call the model through Vercel AI Gateway.`
    : ''
}

/**
 * The provider's own package on direct, or the Vercel AI Gateway on vercel. Throws, naming the
 * model, its prefix and the keys that would work, when none is set, when the key it would send
 * has whitespace or a line break in it, or when Vercel's project token has expired.
 */
export function judgeRoute(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
  what = 'judge model',
  gateway: GatewayName = 'direct',
): JudgeRoute {
  const provider = providerOf(model)
  const direct = DIRECT_PROVIDERS[provider]
  const keys = judgeCredentials(model, gateway)
  if (!keys.length) {
    throw new Error(
      `${what} "${model}" needs vercel() in the config's gateway list: direct() calls only ${Object.keys(
        DIRECT_PROVIDERS,
      )
        .map((p) => `${p}/*`)
        .join(', ')} models.`,
    )
  }
  const key = keys.find((k) => env[k])
  if (key === undefined) {
    throw new Error(
      `No credentials for ${what} "${model}" (provider "${provider}"). Set ${modelKeyOptions(model, gateway)}, in the environment or .env.local.${unusedGatewayKey(env, gateway)}`,
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
