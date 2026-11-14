// Short-lived access tokens reeval mints on the host and the egress gateway adds to an agent's
// requests: never in the sandbox, and swapped for a fresh one before each expires.
import type { RequestTransformation } from '@reeval/sandbox-docker'

/** An access token and when it stops working, in epoch milliseconds. */
export type AccessToken = { token: string; expiresAt: number }

/** Mints an access token on the host. */
export type TokenSource = () => Promise<AccessToken>

/** A token the gateway adds to the agent's requests, in place of a credential from the environment. */
export type BrokeredToken = {
  source: TokenSource
  /** The rules that add the token to the requests it's for, and to no other. */
  transformations: (token: string) => RequestTransformation[]
}

/** How long before a token expires it's replaced. */
export const REFRESH_EARLY_MS = 5 * 60_000
/** The shortest wait between refreshes, for a source that hands back a token close to expiry. */
export const MIN_REFRESH_MS = 30_000
/** How long a failed refresh waits before it tries again; the current token still works. */
export const RETRY_MS = 30_000

/**
 * `source`, sharing one token until it's within {@link REFRESH_EARLY_MS} of expiring, and one
 * mint between calls that ask at once.
 */
export function cachedTokenSource(source: TokenSource, now = Date.now): TokenSource {
  let current: AccessToken | undefined
  let pending: Promise<AccessToken> | undefined
  return () => {
    if (current && current.expiresAt - REFRESH_EARLY_MS > now()) return Promise.resolve(current)
    pending ??= source()
      .then((token) => {
        current = token
        return token
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
}

type Schedule = (run: () => void, ms: number) => () => void

const unrefTimer: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  timer.unref()
  return () => clearTimeout(timer)
}

/** The sandbox session's side of brokering: rules added later win over earlier ones. */
export type TokenSession = {
  addRequestTransformations?: (rules: readonly RequestTransformation[]) => PromiseLike<void>
}

/**
 * Adds the token's rules to the session, then again with a fresh token before each expires,
 * until the returned stop is called. Throws when the first token can't be minted; a later failure
 * is passed to `onError` and retried after {@link RETRY_MS}, while the current token still works.
 */
export async function brokerToken(
  brokered: BrokeredToken,
  session: TokenSession,
  options: {
    now?: () => number
    schedule?: Schedule
    onRefresh?: (token: AccessToken) => void
    onError?: (error: unknown) => void
  } = {},
): Promise<() => void> {
  const { now = Date.now, schedule = unrefTimer } = options
  const add = session.addRequestTransformations?.bind(session)
  if (!add) throw new Error("the sandbox can't add request transformations")
  let stopped = false
  let cancel = () => {}
  const apply = async () => {
    const token = await brokered.source()
    if (!stopped) await add(brokered.transformations(token.token))
    return token
  }
  const plan = (token: AccessToken) => {
    if (stopped) return
    const wait = Math.max(token.expiresAt - REFRESH_EARLY_MS - now(), MIN_REFRESH_MS)
    cancel = schedule(() => void refresh(), wait)
  }
  const refresh = async () => {
    try {
      const token = await apply()
      options.onRefresh?.(token)
      plan(token)
    } catch (error) {
      options.onError?.(error)
      if (!stopped) cancel = schedule(() => void refresh(), RETRY_MS)
    }
  }
  plan(await apply())
  return () => {
    stopped = true
    cancel()
  }
}
