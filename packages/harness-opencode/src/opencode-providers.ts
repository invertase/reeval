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

/**
 * A variable a provider needs besides its key, which isn't secret: OpenCode builds its hosts from
 * it, so the table's hosts have `{NAME}` in its place.
 */
export type OpenCodeProviderVar = {
  readonly name: string
  /** OpenCode's own default, when the host doesn't set it. */
  readonly default: string
  /** What a value must look like, since it goes into a host name. */
  readonly pattern: string
}

/** A provider whose key OpenCode sends in a header on known hosts, so a gateway can broker it. */
export type OpenCodeProvider = {
  /** OpenCode's provider id, the part of a model id before the first `/`. */
  readonly id: string
  readonly name: string
  /** The variable OpenCode reads the key from, which ES reads on the host. */
  readonly env: string
  /** Variables its hosts are built from, such as Bedrock's `AWS_REGION`. */
  readonly vars?: readonly OpenCodeProviderVar[]
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
  if (typeof model !== 'string') return undefined
  const at = model.indexOf('/')
  if (at <= 0 || at === model.length - 1) return undefined
  return { provider: model.slice(0, at), model: model.slice(at + 1) }
}

/**
 * The provider a model id runs on, with its hosts built from `env`'s values for its variables
 * (or their defaults), and those values, which go into the sandbox as they are. Or why it can't
 * run: the id has no provider, OpenCode doesn't know the provider, ES can't broker its key, or a
 * variable's value can't be part of a host name.
 */
export function resolveOpenCodeProvider(
  model: string,
  env: Record<string, string | undefined> = {},
): { provider: OpenCodeProvider; vars: Record<string, string> } | { error: string } {
  const split = splitModel(model)
  if (!split) {
    return {
      error: `an OpenCode model id names its provider, <provider>/<model>, such as 'google/gemini-3.8-flash' or 'anthropic/claude-haiku-4-5' (got ${JSON.stringify(model)})`,
    }
  }
  const provider = byId.get(split.provider)
  if (provider) {
    const vars: Record<string, string> = {}
    for (const v of provider.vars ?? []) {
      const value = env[v.name] || v.default
      if (!new RegExp(v.pattern).test(value)) {
        return {
          error: `${v.name} is ${JSON.stringify(value)}, which isn't one ${provider.name} (${provider.id}) takes: OpenCode builds its API's host from it, so it must match /${v.pattern}/, such as ${JSON.stringify(v.default)}`,
        }
      }
      vars[v.name] = value
    }
    const fill = (host: string) =>
      Object.entries(vars).reduce((h, [name, value]) => h.replaceAll(`{${name}}`, value), host)
    const endpoints = provider.endpoints.map((e) => ({ ...e, host: fill(e.host) }))
    return { provider: { ...provider, endpoints }, vars }
  }
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
export function openCodeProvider(
  model: string,
  env: Record<string, string | undefined> = {},
): OpenCodeProvider {
  const resolved = resolveOpenCodeProvider(model, env)
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
