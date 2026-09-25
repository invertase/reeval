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

/**
 * A request a brokered credential may be sent on: the host, and optionally the path and methods,
 * in the same shape as a request transformation's `match`.
 */
export type EndpointMatch = Pick<RequestTransformation['match'], 'host' | 'path' | 'method'>

/** Whether the request is one of the endpoints (host, path and method, where given). */
export const onEndpoint = (endpoints: readonly EndpointMatch[], request: OutboundRequest) =>
  endpoints.some((match) => matches({ match, transform: { headers: {} } }, request))

/** Whether the gateway must decrypt connections to `host`: some rule could apply there. */
export const decrypts = (rules: readonly RequestTransformation[], host: string) =>
  rules.some((r) => normaliseHost(r.match.host) === normaliseHost(host))

/**
 * The request's headers after every matching rule, in order, so later rules win. Returns the
 * (lower-case) names that were replaced, for logging without values. With `endpoints`, no rule
 * applies off them, and a request carrying a rule's placeholder there is `refused`.
 */
export function applyTransformations(
  rules: readonly RequestTransformation[],
  request: OutboundRequest,
  endpoints?: readonly EndpointMatch[],
): { headers: OutboundRequest['headers']; replaced: string[]; refused: boolean } {
  const headers = { ...request.headers }
  const replaced = new Set<string>()
  const matching = rules.filter((rule) => matches(rule, request))
  if (endpoints && matching.length && !onEndpoint(endpoints, request)) {
    // Refused when the request carries what a rule keys on (a placeholder); a rule that only
    // adds headers just doesn't apply here.
    return { headers, replaced: [], refused: matching.some((r) => r.match.headers?.length) }
  }
  for (const rule of matching) {
    for (const [name, value] of Object.entries(rule.transform.headers)) {
      headers[name.toLowerCase()] = value
      replaced.add(name.toLowerCase())
    }
  }
  return { headers, replaced: [...replaced], refused: false }
}
