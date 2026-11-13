// `reeval login`, `reeval logout` and `reeval whoami` against the cloud platform at
// `REEVAL_CLOUD_URL` (https://cloud.reeval.ai when that isn't set). Login is the OAuth device
// flow (RFC 8628): the platform gives a code, you approve it on its page in a browser, and the
// CLI, polling, gets a bearer token it keeps for the cloud calls (`credentials.ts`).
import type { Flags } from '../cli-spec.ts'
import {
  CloudError,
  call,
  cloudUrl,
  platformMessage,
  refusedHint,
  request,
  shownCloudUrl as shown,
} from '../cloud-run.ts'
import { UsageError } from '../errors.ts'
import {
  CLOUD_TOKEN_VAR,
  type CloudToken,
  cloudToken,
  credentialsPath,
  removeLogin,
  type Stored,
  saveLogin,
  storedLogin,
  storedLogins,
} from './credentials.ts'
import { keychain } from './keychain.ts'
import type { SignedInUser } from './types.ts'

/** The client the platform lets start and redeem a device sign-in. */
export const CLIENT_ID = 'reeval-cli'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
/** How many failed polls in a row (no answer, or a 5xx) end the wait. */
const POLL_FAILURES = 3
/** The shortest wait between polls, whatever interval the platform asks for. */
const MIN_INTERVAL_MS = 1000

export type LoginIo = {
  out: (line: string) => void
  err: (line: string) => void
  env?: NodeJS.ProcessEnv
  /** Opens the approval page in a browser; absent where there's none to open. */
  open?: (url: string) => void
  sleep?: (ms: number) => Promise<void>
}

type DeviceCode = {
  device_code?: unknown
  user_code?: unknown
  verification_uri?: unknown
  verification_uri_complete?: unknown
  expires_in?: unknown
  interval?: unknown
}

const JSON_BODY = { 'content-type': 'application/json' }

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const who = (user: SignedInUser) =>
  user.name && user.email ? `${user.name} <${user.email}>` : user.email || user.name || user.id

/** Who the token signs in as, or null when the platform refuses it. */
async function signedInUser(base: URL, token: string): Promise<SignedInUser | null> {
  const what = 'read who is signed in'
  const res = await request(
    new URL('api/me', base),
    { method: 'GET', what },
    { authorization: `Bearer ${token}` },
  )
  if (res.status === 401 || res.status === 403) return null
  const why = platformMessage(res.body) ?? `HTTP ${res.status}`
  if (!res.ok) {
    throw res.status < 500
      ? new UsageError(`the cloud platform refused to ${what}: ${why}`)
      : new CloudError(`couldn't ${what}: ${why}`)
  }
  const user = (res.body as { user?: Record<string, unknown> } | null)?.user
  if (typeof user?.email !== 'string') {
    throw new CloudError(`couldn't ${what}: the cloud platform answered without a user`)
  }
  return {
    ...(typeof user.id === 'string' && { id: user.id }),
    email: user.email,
    ...(typeof user.name === 'string' && { name: user.name }),
  }
}

/** Revokes the token's session on the platform; one it already refuses counts as revoked. */
async function signOut(base: URL, token: string): Promise<void> {
  const res = await request(
    new URL('api/auth/sign-out', base),
    {
      method: 'POST',
      what: 'sign out',
      headers: { ...JSON_BODY, origin: base.origin },
      body: '{}',
    },
    { authorization: `Bearer ${token}` },
  )
  if (res.ok || res.status === 401) return
  throw new Error(platformMessage(res.body) ?? `HTTP ${res.status}`)
}

/** A stored sign-in as a warning names it: its key and who it signs in as. */
const signIn = (s: Stored) => `the sign-in to ${s.key} (${who(s.login.user)})`

/** Everyone the stored sign-ins sign in as, once each. */
const whoAll = (stored: readonly Stored[]) =>
  [...new Set(stored.map((s) => who(s.login.user)))].join(', ')

/**
 * Revokes each distinct token of the platform's stored sign-ins once, but `keep`, warning about
 * every sign-in it couldn't revoke: a keychain item that didn't return its token (which the
 * keychain may still hold) or a token the platform didn't revoke.
 */
async function revokeAll(
  base: URL,
  stored: readonly Stored[],
  io: LoginIo,
  keep?: string,
): Promise<{ revoked: number; failed: boolean }> {
  let revoked = 0
  let failed = false
  const byToken = new Map<string, Stored[]>()
  for (const s of stored) {
    if (s.token) {
      if (s.token !== keep) byToken.set(s.token, [...(byToken.get(s.token) ?? []), s])
    } else if (s.login.store === 'keychain') {
      failed = true
      io.err(
        `reeval: the keychain didn't return the token of ${signIn(s)}, so it wasn't revoked on the platform and the keychain may still hold it.`,
      )
    }
  }
  for (const [token, holders] of byToken) {
    try {
      await signOut(base, token)
      revoked++
    } catch (error) {
      failed = true
      io.err(
        `reeval: couldn't revoke ${holders.map(signIn).join(' and ')} on the platform (${(error as Error).message}); it stays valid until it expires.`,
      )
    }
  }
  return { revoked, failed }
}

/** Polls for the token until the code is approved, denied or expires. */
async function awaitApproval(
  base: URL,
  code: DeviceCode & { device_code: string },
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  const url = new URL('api/auth/device/token', base)
  const body = JSON.stringify({
    grant_type: DEVICE_GRANT,
    device_code: code.device_code,
    client_id: CLIENT_ID,
  })
  const seconds = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
  let interval = Math.max(seconds(code.interval, 5) * 1000, MIN_INTERVAL_MS)
  const deadline = Date.now() + seconds(code.expires_in, 30 * 60) * 1000
  const expired = new UsageError('The code expired before it was approved: run reeval login again.')
  let failures = 0
  while (Date.now() < deadline) {
    await sleep(interval)
    let res: Awaited<ReturnType<typeof request>>
    try {
      res = await request(
        url,
        { method: 'POST', what: 'check the sign-in', headers: JSON_BODY, body },
        {},
      )
    } catch (error) {
      if (++failures >= POLL_FAILURES) throw error
      continue
    }
    const answer = res.body as { access_token?: unknown; error?: unknown } | null
    if (res.ok) {
      if (typeof answer?.access_token === 'string' && answer.access_token) {
        return answer.access_token
      }
      throw new CloudError('the cloud platform approved the sign-in without a token')
    }
    const said = platformMessage(res.body) ?? `HTTP ${res.status}`
    if (res.status >= 500) {
      if (++failures >= POLL_FAILURES) throw new CloudError(`couldn't check the sign-in: ${said}`)
      continue
    }
    failures = 0
    if (res.status === 429) {
      interval += 5000
      continue
    }
    switch (answer?.error) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        interval += 5000
        continue
      case 'expired_token':
        throw expired
      case 'access_denied':
        throw new UsageError('The sign-in was denied on the approval page.')
    }
    throw new UsageError(`the cloud platform refused the sign-in: ${said}`)
  }
  throw expired
}

/** `reeval login`: signs in to the platform and keeps its token for the cloud calls. */
export async function loginCommand(io: LoginIo): Promise<number> {
  const env = io.env ?? process.env
  const base = cloudUrl(env)
  // Read first, so a credentials file reeval can't read refuses before a session is made.
  const previous = await storedLogins(base, env)
  const code = await call<DeviceCode | null>(
    new URL('api/auth/device/code', base),
    {
      method: 'POST',
      what: 'start signing in',
      headers: JSON_BODY,
      body: JSON.stringify({ client_id: CLIENT_ID }),
    },
    { headers: {}, refused: '' },
  )
  const raw =
    typeof code?.verification_uri_complete === 'string'
      ? code.verification_uri_complete
      : code?.verification_uri
  if (
    typeof code?.device_code !== 'string' ||
    typeof code.user_code !== 'string' ||
    typeof raw !== 'string'
  ) {
    throw new CloudError('the cloud platform started a sign-in without a code and a page for it')
  }
  // Only a page of the platform's own is printed or opened, and only a plain code is printed.
  const parsed = URL.parse(raw, base)
  if (!parsed || parsed.origin !== base.origin || !/^[\w-]{1,64}$/.test(code.user_code)) {
    throw new CloudError("the cloud platform's sign-in page or code isn't one reeval opens")
  }
  const page = parsed.href
  io.out(`Open ${page} and check it shows the code ${code.user_code}, then approve it.`)
  io.open?.(page)
  io.out('Waiting for the approval (Ctrl-C to stop)…')
  const token = await awaitApproval(
    base,
    { ...code, device_code: code.device_code },
    io.sleep ?? sleepMs,
  )
  const user = await signedInUser(base, token)
  if (!user) {
    throw new UsageError(
      'the cloud platform refused the token it gave for this sign-in: run reeval login again',
    )
  }
  const where = await saveLogin(base, token, user, env)
  await revokeAll(base, previous, io, token)
  io.out(`Signed in to ${shown(base)} as ${who(user)}; the token is in ${where}.`)
  if (env[CLOUD_TOKEN_VAR]?.trim()) {
    io.err(`${CLOUD_TOKEN_VAR} is set, so the cloud calls send it instead of this sign-in.`)
  }
  return 0
}

/** `reeval logout`: revokes the stored sign-in on the platform and forgets it here. */
export async function logoutCommand(io: LoginIo): Promise<number> {
  const env = io.env ?? process.env
  const base = cloudUrl(env)
  const stored = await storedLogins(base, env)
  if (!stored.length) {
    io.out(`Not signed in to ${shown(base)} with reeval login.`)
  } else {
    const { revoked, failed } = await revokeAll(base, stored, io)
    await removeLogin(base, env)
    io.out(
      revoked && !failed
        ? `Signed out of ${shown(base)} (${whoAll(stored)}).`
        : `Removed the sign-in to ${shown(base)} (${whoAll(stored)}) from this machine's credentials.`,
    )
  }
  if (env[CLOUD_TOKEN_VAR]?.trim()) {
    io.err(`${CLOUD_TOKEN_VAR} is still set: reeval logout doesn't change it.`)
  }
  return 0
}

/** Where `reeval whoami` says the token came from. */
function tokenSource(token: CloudToken, env: NodeJS.ProcessEnv): string {
  if (token.from === 'env') return CLOUD_TOKEN_VAR
  if (token.from === 'keychain') return keychain(env)?.name ?? 'the keychain'
  return credentialsPath(env)
}

/** `reeval whoami`: who the cloud calls sign in as, asking the platform. */
export async function whoamiCommand(flags: Flags, io: LoginIo): Promise<number> {
  const env = io.env ?? process.env
  const base = cloudUrl(env)
  const token = await cloudToken(base, env)
  if (!token) {
    const stored = await storedLogin(base, env)
    throw new UsageError(
      stored
        ? `The sign-in to ${shown(base)} is in ${credentialsPath(env)}, but the keychain didn't return its token: reeval login signs in again.`
        : `Not signed in to ${shown(base)}: ${refusedHint(null)}.`,
    )
  }
  const user = await signedInUser(base, token.token)
  if (!user) {
    throw new UsageError(
      token.from === 'env'
        ? `The cloud platform at ${shown(base)} refused ${CLOUD_TOKEN_VAR}: check it.`
        : `The sign-in to ${shown(base)} has expired or was revoked: reeval login signs in again.`,
    )
  }
  const from = tokenSource(token, env)
  if (flags.json) {
    io.out(JSON.stringify({ url: shown(base), user, tokenFrom: from }, null, 2))
  } else {
    io.out(`Signed in to ${shown(base)} as ${who(user)} (token from ${from})`)
  }
  return 0
}
