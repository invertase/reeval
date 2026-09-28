import { OPENCODE_PROVIDERS, REFUSED_OPENCODE_PROVIDERS } from './opencode-provider-table.ts'

/** A header OpenCode sends a provider's key in: `Authorization: Bearer <key>`, or the key alone. */
export type OpenCodeKeyHeader = { readonly name: string; readonly scheme: 'bearer' | 'raw' }

/**
 * A request OpenCode sends the key on. A path with the model in it is a regex whose one group
 * is the model; a `POST` is a model call, whose response or URL names the model that served it.
 */
export type OpenCodeEndpoint = {
  readonly host: string
  readonly method: readonly string[]
  readonly path: { readonly exact: string } | { readonly regex: string }
}

/** A provider whose key OpenCode sends in a header on fixed hosts, so a gateway can broker it. */
export type OpenCodeProvider = {
  /** OpenCode's provider id, the part of a model id before the first `/`. */
  readonly id: string
  readonly name: string
  /** The variable OpenCode reads the key from, which ES reads on the host. */
  readonly env: string
  /** Where OpenCode puts the key (a provider whose models use several APIs has one per API). */
  readonly headers: readonly OpenCodeKeyHeader[]
  /** Every request OpenCode was seen to send the key on. */
  readonly endpoints: readonly OpenCodeEndpoint[]
}

/** A provider OpenCode knows whose key a gateway can't broker, and why. */
export type RefusedOpenCodeProvider = {
  readonly id: string
  readonly name: string
  readonly why: string
}

export { OPENCODE_PROVIDERS, REFUSED_OPENCODE_PROVIDERS }

const byId = new Map(OPENCODE_PROVIDERS.map((p) => [p.id, p]))
const refusedById = new Map(REFUSED_OPENCODE_PROVIDERS.map((p) => [p.id, p]))

/** A model id's provider and the model within it: `openrouter/anthropic/x` is `openrouter`. */
export function splitModel(model: string): { provider: string; model: string } | undefined {
  const at = model.indexOf('/')
  if (at <= 0 || at === model.length - 1) return undefined
  return { provider: model.slice(0, at), model: model.slice(at + 1) }
}

/**
 * The provider a model id runs on, or why it can't: the id has no provider, OpenCode doesn't
 * know the provider, or ES can't broker its key.
 */
export function resolveOpenCodeProvider(
  model: string,
): { provider: OpenCodeProvider } | { error: string } {
  const split = splitModel(model)
  if (!split) {
    return {
      error: `an OpenCode model id names its provider, <provider>/<model>, such as 'google/gemini-3.8-flash' or 'anthropic/claude-haiku-4-5' (got ${JSON.stringify(model)})`,
    }
  }
  const provider = byId.get(split.provider)
  if (provider) return { provider }
  const refused = refusedById.get(split.provider)
  if (refused) {
    return {
      error: `ES can't run OpenCode on ${refused.name} (${refused.id}): ${refused.why}, so the gateway can't keep its key out of the sandbox`,
    }
  }
  return {
    error: `OpenCode has no provider ${JSON.stringify(split.provider)} (in ${JSON.stringify(model)}); a model id is <provider>/<model>, such as 'google/gemini-3.8-flash'`,
  }
}

/** Like {@link resolveOpenCodeProvider}, throwing its reason. */
export function openCodeProvider(model: string): OpenCodeProvider {
  const resolved = resolveOpenCodeProvider(model)
  if ('error' in resolved) throw new Error(resolved.error)
  return resolved.provider
}

/** The hosts a provider's key goes to, which a restricted egress policy allows for it. */
export const providerHosts = (provider: OpenCodeProvider) => [
  ...new Set(provider.endpoints.map((e) => e.host)),
]

const headerValue = (header: OpenCodeKeyHeader, key: string) =>
  header.scheme === 'bearer' ? `Bearer ${key}` : key

/**
 * The gateway rules that swap the key in: on each of the provider's hosts, for each header it
 * sends the key in, the placeholder for the real key.
 */
export function providerTransformations(
  provider: OpenCodeProvider,
  {
    key,
    placeholder,
    headers = {},
  }: { key: string; placeholder: string; headers?: Record<string, string> },
) {
  return providerHosts(provider).flatMap((host) =>
    provider.headers.map((header) => ({
      matchUrl: `https://${host}`,
      matchHeaders: { [header.name]: headerValue(header, placeholder) },
      transformHeaders: { ...headers, [header.name]: headerValue(header, key) },
    })),
  )
}

const pathOf = (e: OpenCodeEndpoint) =>
  'exact' in e.path ? { exact: e.path.exact } : { regex: e.path.regex }

/** The endpoints as a gateway matches them. */
export const providerEndpoints = (provider: OpenCodeProvider) =>
  provider.endpoints.map((e) => ({ host: e.host, method: [...e.method], path: pathOf(e) }))

/** The model calls whose URL doesn't name the model: their response body does. */
export const providerModelResponses = (provider: OpenCodeProvider) =>
  providerEndpoints(provider).filter((e) => e.method.includes('POST') && 'exact' in e.path)

/**
 * The model a request to the provider's API says served it: from the URL where the path names
 * it (Gemini's API), else from the response's `model`, with the reasoning effort it reports.
 */
export function providerServedModel(
  provider: OpenCodeProvider,
  request: {
    method: string
    host: string
    path: string
    responseModel?: string
    responseEffort?: string
  },
): string | undefined {
  const path = request.path.split('?')[0] ?? request.path
  for (const e of provider.endpoints) {
    if (e.host !== request.host || !e.method.includes(request.method) || request.method !== 'POST')
      continue
    if ('regex' in e.path) {
      const model = new RegExp(e.path.regex).exec(path)?.[1]
      if (model) return decodeURIComponent(model)
    } else if (e.path.exact === path && request.responseModel) {
      return `${request.responseModel}${request.responseEffort ? `[effort=${request.responseEffort}]` : ''}`
    }
  }
  return undefined
}
