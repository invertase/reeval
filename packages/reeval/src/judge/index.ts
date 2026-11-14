import { apiHost, OPENROUTER_HOST } from '@reeval/agents'
import { hostAllowed } from '@reeval/sandbox-docker'
import { OPENROUTER_KEY } from '../gateway/openrouter.ts'
import { ROUTING_GATEWAYS, type RoutingGatewayName } from '../gateway/routes.ts'
import {
  VERCEL_AI_SDK_PATH,
  VERCEL_KEY,
  VERCEL_OIDC,
  vercelApi,
  vercelBaseUrl,
  vercelBaseUrlProblem,
  vercelCredentialProblem,
} from '../gateway/vercel.ts'
import { vertexSettings } from '../gateway/vertex.ts'
import type { JudgeRetry } from '../history/types.ts'
import { badCharacterAt, isPlaceholder, redactSecrets } from '../redact.ts'
import { heldSecret, hostEnv } from '../secrets-file.ts'
import { nativeFetch, startEnv } from '../startup.ts'
import type {
  FakeJudgeModel,
  GatewayName,
  JudgeModel,
  JudgeOptions,
  JudgeState,
  TokenUsage,
  Verdict,
} from '../types.ts'
import { JUDGE_RETRY, type RetryPolicy, withRetries } from './retry.ts'

/** The judge the docs recommend, pinned so a model update never silently moves scores. */
export const RECOMMENDED_JUDGE_MODEL = 'typesafe-ai/jev-1.14.0'
/** The same judge as OpenRouter names it. */
export const OPENROUTER_JUDGE_MODEL = 'typesafe/jev-1.14'
/** The language model `reeval init` sets as `analysis.model` and `reeval analyze` uses. */
export const RECOMMENDED_ANALYSIS_MODEL = 'google/gemini-3.8-flash'
export const DEFAULT_THRESHOLD = 0.8

const GATEWAY_KEYS = [VERCEL_KEY, VERCEL_OIDC]

/** Each routing gateway's keys, in the order reeval prefers them. */
const ROUTED_KEYS: Readonly<Record<RoutingGatewayName, readonly string[]>> = {
  vercel: GATEWAY_KEYS,
  openrouter: [OPENROUTER_KEY],
}

/**
 * Providers `direct()` calls, each through its own AI SDK package and key, at its API's base URL
 * (the package's default) or the package's base-URL variable's. Any other prefix needs `vercel()`
 * in the config's gateway list.
 */
export const DIRECT_PROVIDERS: Record<
  string,
  { key: string; pkg: string; name: string; api: string; baseUrl?: string }
> = {
  anthropic: {
    key: 'ANTHROPIC_API_KEY',
    pkg: '@ai-sdk/anthropic',
    name: 'Anthropic',
    api: 'https://api.anthropic.com/v1',
    baseUrl: 'ANTHROPIC_BASE_URL',
  },
  google: {
    key: 'GOOGLE_GENERATIVE_AI_API_KEY',
    pkg: '@ai-sdk/google',
    name: 'Google',
    api: 'https://generativelanguage.googleapis.com/v1beta',
  },
  openai: {
    key: 'OPENAI_API_KEY',
    pkg: '@ai-sdk/openai',
    name: 'OpenAI',
    api: 'https://api.openai.com/v1',
    baseUrl: 'OPENAI_BASE_URL',
  },
  'typesafe-ai': {
    key: 'TYPESAFE_AI_API_KEY',
    pkg: '@ai-sdk/typesafe-ai',
    name: 'TypeSafe AI',
    api: 'https://api.typesafe.ai/v1',
    baseUrl: 'TYPESAFE_AI_BASE_URL',
  },
}

/**
 * What a host call's AI SDK provider is made with, settled from the environment `judgeRoute`
 * checked, so nothing the provider reads later can move the key: the base URL (undefined for the
 * package's own fixed one), the key, and for a held brokered key a fetch that sends it only to
 * the key's hosts.
 */
export type HostCall = { baseURL?: string; apiKey?: string; fetch?: typeof fetch }

/**
 * A host call's route: its provider's own package, Vercel AI Gateway by name, OpenRouter's
 * package, or Vertex AI.
 */
export type JudgeRoute =
  | { kind: 'direct'; provider: string; pkg: string }
  | { kind: 'gateway' }
  | { kind: 'openrouter' }
  | { kind: 'vertex' }

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/

/**
 * A fetch for a held brokered key: to `allowed` hosts only, over https unless the host is this
 * machine, through the runtime's own fetch as reeval started with it, and never following a
 * redirect, which could carry the key's header to another origin.
 */
function brokeredFetch(key: string, allowed: (host: string) => boolean): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!allowed(url.hostname) || (url.protocol !== 'https:' && !LOOPBACK.test(url.hostname))) {
      return Promise.reject(
        new Error(`reeval refused to send ${key}, a brokered key, to ${url.origin}.`),
      )
    }
    return nativeFetch(input, { ...init, redirect: 'error' })
  }
}

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
 * vertex none, since its token comes from Application Default Credentials; on another gateway,
 * that gateway's.
 */
export function judgeCredentials(
  model: string | FakeJudgeModel,
  gateway: GatewayName = 'direct',
): string[] {
  if (isFakeJudge(model) || gateway === 'vertex') return []
  if (gateway !== 'direct') return [...ROUTED_KEYS[gateway]]
  const direct = DIRECT_PROVIDERS[providerOf(model)]
  return direct ? [direct.key] : []
}

/** The keys that would work for a model on `on`: `ANTHROPIC_API_KEY (for direct())`. */
export function modelKeyOptions(model: string, on: GatewayName = 'direct'): string {
  if (on === 'vertex') return 'Application Default Credentials (for vertex())'
  if (on !== 'direct') return `${ROUTED_KEYS[on].join(' or ')} (for ${on}())`
  const direct = DIRECT_PROVIDERS[providerOf(model)]
  return direct
    ? `${direct.key} (for direct())`
    : `vercel() in gateway (direct() calls only ${Object.keys(DIRECT_PROVIDERS)
        .map((p) => `${p}/*`)
        .join(', ')} models)`
}

/** A gateway's credential set in `env`, if any, with the gateway it's for. */
export function setGatewayKey(
  env: NodeJS.ProcessEnv,
): { key: string; gateway: RoutingGatewayName } | undefined {
  for (const [gateway, keys] of Object.entries(ROUTED_KEYS)) {
    const key = keys.find((k) => env[k])
    if (key) return { key, gateway: gateway as RoutingGatewayName }
  }
  return undefined
}

/**
 * ` AI_GATEWAY_API_KEY is set, but …` when a gateway's credential is set and the model goes
 * direct, so the key says how to use it.
 */
export function unusedGatewayKey(env: NodeJS.ProcessEnv, gateway: GatewayName = 'direct'): string {
  if (gateway !== 'direct') return ''
  const set = setGatewayKey(env)
  if (!set) return ''
  return ` ${set.key} is set, but no gateway in the config uses it: add ${set.gateway}() to gateway to call the model through ${ROUTING_GATEWAYS[set.gateway].name}.`
}

/**
 * The provider's own package on direct, the Vercel AI Gateway on vercel, or OpenRouter's package
 * on openrouter, or Vertex AI on vertex, whose token is minted when the model is called.
 * Throws, naming the model, its prefix and the keys that would work, when none is
 * set, when the key it would send has whitespace or a line break in it, or when Vercel's project
 * token has expired.
 */
export const judgeRoute = (
  model: string,
  env: NodeJS.ProcessEnv = process.env,
  what = 'judge model',
  gateway: GatewayName = 'direct',
): JudgeRoute => hostCall(model, env, what, gateway).route

/**
 * The route as `judgeRoute` checks it, with what a model factory takes to make the call: the base
 * URL, the key and, for a held key, a fetch that keeps it on its hosts. The call holds the key's
 * value, so it goes straight into the factory and nowhere that's kept or written.
 */
export function hostCall(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
  what = 'judge model',
  gateway: GatewayName = 'direct',
): { route: JudgeRoute; call: HostCall } {
  if (gateway === 'vertex') return { route: { kind: 'vertex' }, call: {} }
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
  // Base URLs come from the environment as it was before any eval code ran, so only the
  // project's own settings decide where a key goes.
  const settings = env === process.env ? startEnv() : env
  const kind =
    gateway === 'openrouter' ? 'openrouter' : direct && key === direct.key ? 'direct' : 'gateway'
  const vercelBase = kind === 'gateway' ? vercelBaseUrl(settings) : undefined
  const baseURL =
    kind === 'direct' && direct
      ? (direct.baseUrl && settings[direct.baseUrl]) || direct.api
      : vercelBase && `${vercelBase}${VERCEL_AI_SDK_PATH}`
  const url = URL.parse(
    baseURL ?? (kind === 'openrouter' ? `https://${OPENROUTER_HOST}` : vercelApi(settings).origin),
  )
  const host =
    url?.hostname ?? (kind === 'gateway' ? apiHost(vercelApi(settings)) : String(baseURL))
  const real = hostEnv(env)
  const call: HostCall = {
    ...(baseURL && { baseURL }),
    ...(kind !== 'gateway' || real[key] !== env[key] ? { apiKey: real[key] } : {}),
  }
  const held = heldSecret(key)
  if (held && isPlaceholder(env[key])) {
    // reeval's own process calls the host, so a brokered key may go where it's brokered to, and
    // the eval code still reads only its placeholder.
    if (key === VERCEL_OIDC) {
      throw new Error(
        `${key} for ${what} "${model}" is a ${held.mode} secret, and the ${what} calls ${host} from reeval's own process, which reads Vercel's project token only from the environment: give ${key} the readable mode, or use AI_GATEWAY_API_KEY.`,
      )
    }
    if (held.mode !== 'brokered') {
      throw new Error(
        `${key} for ${what} "${model}" is a ${held.mode} secret, which only the agent's sandbox gets, and the ${what} calls ${host} from reeval's own process: give ${key} the brokered mode with ${host} among its hosts, or the readable mode.`,
      )
    }
    const { hosts } = held
    if (!hostAllowed(hosts, host)) {
      throw new Error(
        `${key} for ${what} "${model}" is brokered to ${hosts.join(', ')}, and the ${what} calls ${host}, which it isn't brokered to.`,
      )
    }
    if (!url || (url.protocol !== 'https:' && !LOOPBACK.test(url.hostname))) {
      throw new Error(
        `${key} for ${what} "${model}" is brokered, and the ${what} would call ${baseURL}: a brokered key goes only to an https:// URL, or to this machine.`,
      )
    }
    call.fetch = brokeredFetch(key, (h) => hostAllowed(hosts, h))
  }
  if (key === VERCEL_OIDC) {
    const expired = vercelCredentialProblem(real)
    if (expired) throw new Error(`${what} "${model}": ${expired}`)
  }
  const at = badCharacterAt(real[key] as string)
  if (at) {
    throw new Error(
      `${key} for ${what} "${model}" has whitespace or a line break in it at character ${at}. A key copied from a wrapped terminal line picks these up; set it again as one line.`,
    )
  }
  if (kind === 'openrouter') return { route: { kind }, call }
  if (kind === 'direct' && direct) return { route: { kind, provider, pkg: direct.pkg }, call }
  const base = vercelBaseUrlProblem(settings)
  if (base) throw new Error(`${what} "${model}": ${base}`)
  return { route: { kind: 'gateway' }, call }
}

/** A verdict plus the transient failures retried on the way to it. */
export type JudgeResult = {
  verdict: Verdict
  retries: JudgeRetry[]
  /** The call's tokens; null when the provider reported none, and for the fake judge. */
  usage: TokenUsage | null
}

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
  const fallbacks =
    typeof options.gateway === 'object' &&
    options.gateway.kind === 'openrouter' &&
    options.gateway.fallbacks === true
  const vertex =
    gateway === 'vertex'
      ? vertexSettings(
          typeof options.gateway === 'object' && options.gateway.kind === 'vertex'
            ? options.gateway
            : {},
        )
      : undefined
  let score: number
  let resolvedModel: string | undefined
  let billing: { upstream?: string; costUsd?: number } = {}
  let retries: JudgeRetry[] = []
  let usage: TokenUsage | null = null
  if (isFakeJudge(model)) {
    score = typeof model.score === 'function' ? model.score(state) : model.score
  } else {
    if (typeof model === 'string') {
      const problem = checkModelString(model)
      if (problem) throw new Error(problem)
    }
    const { scoreWithModel } = await import('./model.ts')
    const scored = await withRetries(
      () =>
        scoreWithModel(
          model,
          redactSecrets(question),
          state,
          options.providerOptions,
          signal,
          gateway,
          fallbacks,
          vertex,
        ),
      retry,
      signal,
    )
    const { score: scoredAt, resolvedModel: served, usage: used, ...billed } = scored.value
    score = scoredAt
    resolvedModel = served
    usage = used
    billing = billed
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
    ...billing,
  }
  return { verdict, retries, usage }
}
