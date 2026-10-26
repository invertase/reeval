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

/** What a credential the sandbox never sent comes back as. */
const REDACTED = 'reeval_redacted_credential'
/** Shorter values aren't credentials, and scrubbing them would mangle ordinary text. */
const MIN_CREDENTIAL = 16

const schemeAndToken = (value: string) => /^([A-Za-z][\w-]*) +(\S+)$/.exec(value)

/**
 * Whether a rule for `host` sets a credential: a header value long enough to be one, whether it
 * replaces a placeholder the sandbox sent or adds a bearer the sandbox never had.
 */
export const setsCredential = (rules: readonly RequestTransformation[], host: string) =>
  rules.some(
    (r) =>
      normaliseHost(r.match.host) === normaliseHost(host) &&
      Object.values(r.transform.headers).some((v) => v.length >= MIN_CREDENTIAL),
  )

/**
 * The values credential rules for `host` set (rules keyed on a header the sandbox sends, such as
 * a placeholder key), each paired with what the sandbox sent in its place, for scrubbing from
 * responses. A value with a scheme (`Bearer <key>`) is paired as a whole and by its token too.
 */
export function credentialValues(
  rules: readonly RequestTransformation[],
  host: string,
): Array<[value: string, shown: string]> {
  const pairs = new Map<string, string>()
  const add = (value: string, shown: string) => {
    if (value.length >= MIN_CREDENTIAL && value !== shown && !pairs.has(value)) {
      pairs.set(value, shown)
    }
  }
  for (const rule of rules) {
    const keyed = rule.match.headers ?? []
    if (!keyed.length || normaliseHost(rule.match.host) !== normaliseHost(host)) continue
    for (const [name, value] of Object.entries(rule.transform.headers)) {
      const sent = keyed.find(
        (m) => m.key && 'exact' in m.key && m.key.exact.toLowerCase() === name.toLowerCase(),
      )?.value
      const shown = sent && 'exact' in sent ? sent.exact : REDACTED
      add(value, shown)
      const token = schemeAndToken(value)
      const shownToken = schemeAndToken(shown)
      if (token?.[2]) add(token[2], shownToken?.[2] ?? REDACTED)
    }
  }
  return [...pairs]
}

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
