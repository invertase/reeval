import type { HarnessV1RequestTransformation } from '@ai-sdk/harness'

export type RequestTransformation = HarnessV1RequestTransformation

type PartMatcher = { exact: string } | { startsWith: string } | { regex: string }

/** A request as the gateway sees it after decrypting: header names are lower-case. */
export type OutboundRequest = {
  host: string
  method: string
  /** The request target: path plus query string. */
  path: string
  headers: Record<string, string | string[] | undefined>
}

const normaliseHost = (host: string) => host.toLowerCase().replace(/\.$/, '')

function matchPart(matcher: PartMatcher, value: string, ignoreCase = false): boolean {
  const v = ignoreCase ? value.toLowerCase() : value
  if ('exact' in matcher) return v === (ignoreCase ? matcher.exact.toLowerCase() : matcher.exact)
  if ('startsWith' in matcher) {
    return v.startsWith(ignoreCase ? matcher.startsWith.toLowerCase() : matcher.startsWith)
  }
  return new RegExp(matcher.regex, ignoreCase ? 'i' : '').test(value)
}

type KeyValue = RequestTransformation['match']['headers']

/** Every matcher must match at least one pair; keys compare case-insensitively for headers. */
function matchPairs(matchers: KeyValue, pairs: [string, string][], ignoreKeyCase: boolean) {
  return (matchers ?? []).every((m) =>
    pairs.some(
      ([k, v]) =>
        (!m.key || matchPart(m.key, k, ignoreKeyCase)) && (!m.value || matchPart(m.value, v)),
    ),
  )
}

const headerPairs = (headers: OutboundRequest['headers']): [string, string][] =>
  Object.entries(headers).flatMap(([k, v]) =>
    v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x): [string, string] => [k, x]),
  )

export function matches(rule: RequestTransformation, request: OutboundRequest): boolean {
  const { match } = rule
  if (normaliseHost(match.host) !== normaliseHost(request.host)) return false
  const url = new URL(request.path, 'https://placeholder.invalid')
  if (match.path && !matchPart(match.path, url.pathname)) return false
  if (match.method && !match.method.some((m) => m.toUpperCase() === request.method.toUpperCase())) {
    return false
  }
  if (match.queryString && !matchPairs(match.queryString, [...url.searchParams], false)) {
    return false
  }
  return !match.headers || matchPairs(match.headers, headerPairs(request.headers), true)
}

/** An API endpoint that may receive a brokered credential: a host, a path and its methods. */
export type BrokeredEndpoint = { host: string; path: PartMatcher; method: readonly string[] }

type Match = RequestTransformation['match']

function narrow(match: Match, endpoint: BrokeredEndpoint): Match | undefined {
  if (normaliseHost(match.host) !== normaliseHost(endpoint.host)) return undefined
  const method = endpoint.method.filter(
    (m) => !match.method || match.method.some((r) => r.toUpperCase() === m.toUpperCase()),
  )
  if (method.length === 0) return undefined
  const { path } = endpoint
  if (match.path) {
    const sameMatcher = JSON.stringify(match.path) === JSON.stringify(path)
    if (!sameMatcher && !('exact' in path && matchPart(match.path, path.exact))) return undefined
  }
  return { ...match, path, method }
}

/**
 * Each rule cut down to the endpoints it overlaps, one rule per endpoint; rules that overlap
 * none are dropped. A pattern endpoint only keeps a rule with no path or the same pattern.
 */
export function scopeTransformations(
  rules: readonly RequestTransformation[],
  endpoints: readonly BrokeredEndpoint[],
): RequestTransformation[] {
  return rules.flatMap((rule) =>
    endpoints.flatMap((endpoint) => {
      const match = narrow(rule.match, endpoint)
      return match ? [{ ...rule, match }] : []
    }),
  )
}

/** Whether the gateway must decrypt connections to `host`: some rule could apply there. */
export const decrypts = (rules: readonly RequestTransformation[], host: string) =>
  rules.some((r) => normaliseHost(r.match.host) === normaliseHost(host))

/**
 * The request's headers after every matching rule, in order, so later rules win. Returns the
 * (lower-case) names that were replaced, for logging without values.
 */
export function applyTransformations(
  rules: readonly RequestTransformation[],
  request: OutboundRequest,
): { headers: OutboundRequest['headers']; replaced: string[] } {
  const headers = { ...request.headers }
  const replaced = new Set<string>()
  for (const rule of rules) {
    if (!matches(rule, request)) continue
    for (const [name, value] of Object.entries(rule.transform.headers)) {
      headers[name.toLowerCase()] = value
      replaced.add(name.toLowerCase())
    }
  }
  return { headers, replaced: [...replaced] }
}
