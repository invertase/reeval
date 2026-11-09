// `reeval run` on the cloud platform. It bundles the project as `reeval bundle` does, creates the
// run on the platform at `REEVAL_CLOUD_URL`, uploads the bundle and starts it, then follows the
// run's event stream as `reeval attach` does and exits with the run's exit code. A plan the
// platform can't run (a sandbox it has no machine for, files a bundle can't carry) runs on this
// machine instead, with a one-line note.
import { createHash } from 'node:crypto'
import type { AttachOptions } from './attach.ts'
import type { MadeBundle } from './bundle/index.ts'
import { type FlagName, type Flags, RUN_FLAGS } from './cli-spec.ts'
import type { PlannedItem } from './engine/node.ts'
import { UsageError } from './errors.ts'
import { displayUrl, EventStreamError, type FollowOptions } from './events.ts'
import type { PlanDocument } from './plan.ts'
import { stripCredentials } from './redact.ts'
import { sandboxKind } from './sandbox/kinds.ts'
import { plural } from './text.ts'
import type { ResolvedConfig, ResolvedProfile } from './types.ts'

/** The platform's URL, as the cloud run reads it. */
export const CLOUD_URL_VAR = 'REEVAL_CLOUD_URL'
/** A bearer token the cloud run sends the platform, when it's set. */
export const CLOUD_TOKEN_VAR = 'REEVAL_TOKEN'

/** The exit code of a run this terminal detached from, as of one it interrupted. */
const INTERRUPTED = 130

/** A failure of the platform or the way to it: exit 3. */
export class CloudError extends Error {
  override name = 'CloudError'
}

/**
 * Where a run that asked for the cloud platform runs: there, or here and why. `--dry-run --json`
 * prints it as the plan's `target`.
 */
export type RunTarget = NonNullable<PlanDocument['target']>

/**
 * Whether the run goes to the cloud platform: `--cloud` or `--local`, else the profile's
 * `cloud`, else the config's. Only these turn it on, so a CI job runs in the cloud only when its
 * config or command line says so.
 */
export function wantsCloud(
  flags: Flags,
  config: Pick<ResolvedConfig, 'cloud'>,
  profile: Pick<ResolvedProfile, 'cloud'> | null,
): boolean {
  if (flags.cloud && flags.local) {
    throw new UsageError('--cloud and --local pick where the run goes: pass one of them.')
  }
  if (flags.cloud) return true
  if (flags.local) return false
  return profile?.cloud ?? config.cloud
}

/**
 * The run flags a cloud run takes: the ones its bundle carries (filters aside) and the ones that
 * only change how this terminal shows it. `--json` only with `--dry-run`.
 */
const CLOUD_FLAGS = new Set<FlagName>([
  'profile',
  'tag',
  'trait',
  'runs',
  'dry-run',
  'json',
  'cloud',
  'local',
  'ui',
  'log-order',
  'log-prefix',
  'output-logs',
  'verbose',
])

/** Refuses, naming them, the run flags a cloud run can't take. */
export function refuseLocalFlags(flags: Flags): void {
  const given = RUN_FLAGS.filter(
    (f) =>
      flags[f] !== undefined &&
      flags[f] !== false &&
      (!CLOUD_FLAGS.has(f) || (f === 'json' && !flags['dry-run'])),
  )
  if (!given.length) return
  const names = given.map((f) => `--${f}`).join(', ')
  throw new UsageError(
    `${names} ${given.length === 1 ? 'applies' : 'apply'} to a run on this machine, not a cloud one: leave ${given.length === 1 ? 'it' : 'them'} out, or pass --local to run here.`,
  )
}

/**
 * Why the cloud platform can't run the planned attempts, one line per reason with the evals it
 * holds back; empty when it can.
 */
export function notCloud(planned: readonly PlannedItem[]): string[] {
  const why = new Map<string, Set<string>>()
  for (const { id, attempt } of planned) {
    if (attempt.skip || attempt.plan.skip) continue
    const reason = sandboxKind(attempt.sandbox).notCloud?.(attempt.sandbox)
    if (reason) why.set(reason, (why.get(reason) ?? new Set()).add(id))
  }
  return [...why].map(([reason, ids]) => {
    const evals = [...ids]
    const named = evals.slice(0, 2).join(', ') + (evals.length > 2 ? ', …' : '')
    return `${reason} (${named})`
  })
}

/** The platform's URL from `REEVAL_CLOUD_URL`: exit 2 when it's unset or not an http(s) URL. */
export function cloudUrl(env: NodeJS.ProcessEnv = process.env): URL {
  const raw = env[CLOUD_URL_VAR]?.trim()
  if (!raw) {
    throw new UsageError(
      `A cloud run needs ${CLOUD_URL_VAR}, the cloud platform's URL. Set it, or pass --local to run here.`,
    )
  }
  const url = URL.parse(raw)
  if (!url || !/^https?:$/.test(url.protocol)) {
    throw new UsageError(`${CLOUD_URL_VAR} is an http or https URL (got ${stripCredentials(raw)})`)
  }
  if (url.username || url.password) {
    throw new UsageError(
      `${CLOUD_URL_VAR} can't carry a user name or password (got ${stripCredentials(raw)}): set ${CLOUD_TOKEN_VAR} instead`,
    )
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

/**
 * `Running in the cloud (3 attempts, est. $0.10–0.30), --local to run here`, from the plan the
 * bundle was made with. The estimate is left out when the plan has no prices for it or costs
 * nothing.
 */
export async function cloudLine(
  plan: MadeBundle['plan'],
  lead = 'Running in the cloud',
): Promise<string> {
  const { formatUsdRange } = await import('./cost.ts')
  const totals = plan.totals ?? { attempts: 0, fewest: 0 }
  const attempts =
    totals.fewest < totals.attempts
      ? `${totals.fewest}–${totals.attempts} attempts`
      : plural(totals.attempts, 'attempt')
  const { cost } = plan
  const priced =
    cost?.usd && cost.usd.high > 0 && !('why' in cost.prices) && cost.unpricedTokens.high === 0
  const est = priced && cost?.usd ? `, est. ${formatUsdRange(cost.usd)}` : ''
  return `${lead} (${attempts}${est}), --local to run here`
}

/** The headers every platform request carries: the bearer token, when one is set. */
function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env[CLOUD_TOKEN_VAR]?.trim()
  if (!token) return {}
  const bad = [...token].findIndex((c) => /[\s\p{Cc}]/u.test(c))
  if (bad >= 0) {
    const code = token.codePointAt(bad)?.toString(16).padStart(4, '0')
    throw new UsageError(
      `${CLOUD_TOKEN_VAR} has whitespace or a control character (U+${code}) at position ${bad + 1}: set it to the token alone.`,
    )
  }
  return { authorization: `Bearer ${token}` }
}

/**
 * How `reeval attach` follows `source`: with the bearer token when it's the cloud platform's,
 * else as any other stream.
 */
export function cloudFollow(
  source: string,
  env: NodeJS.ProcessEnv = process.env,
): FollowOptions | undefined {
  const raw = env[CLOUD_URL_VAR]?.trim()
  const platform = raw ? URL.parse(raw) : null
  const url = URL.parse(source)
  if (!platform || !url) return undefined
  const origin = (u: URL) => `${u.protocol.replace(/^ws/, 'http')}//${u.host}`
  if (origin(platform) !== origin(url)) return undefined
  const headers = authHeaders(env)
  if (!headers.authorization) return undefined
  return { connect: (u) => new WebSocket(u, { headers } as unknown as string[]) }
}

type PlatformRun = {
  id: string
  status: string
  error?: { code: string; message: string } | null
  exitCode?: number | null
}

/** One request to the platform, JSON in and out; a refusal (4xx) exits 2, any other failure 3. */
async function call<T>(
  url: URL,
  init: RequestInit & { what: string; timeoutMs?: number },
  headers: Record<string, string>,
): Promise<T> {
  const { what, timeoutMs = 30_000, ...rest } = init
  let res: Response
  try {
    res = await fetch(url, {
      ...rest,
      headers: { accept: 'application/json', ...headers, ...rest.headers },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const reason = error instanceof Error ? (error.cause ?? error).toString() : String(error)
    throw new CloudError(`couldn't ${what}: ${displayUrl(url.href)} didn't answer (${reason})`)
  }
  const text = await res.text().catch(() => '')
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {}
  if (!res.ok) {
    const said = (body as { error?: { message?: unknown } } | null)?.error?.message
    const auth = res.status === 401 || res.status === 403 ? ` (check ${CLOUD_TOKEN_VAR})` : ''
    const why = `${typeof said === 'string' ? said : `HTTP ${res.status}`}${auth}`
    const message = `the cloud platform refused to ${what}: ${why}`
    throw res.status >= 400 && res.status < 500
      ? new UsageError(message)
      : new CloudError(`couldn't ${what}: ${why}`)
  }
  return body as T
}

/**
 * The environment the bundle is planned with, so the run plans on the platform as it did here:
 * the model gateway base URL the platform's runs use, when its config names one.
 */
export async function cloudPlanEnv(
  base: URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const config = await call<{ gatewayBaseUrl?: string | null }>(
    new URL('api/config', base),
    { method: 'GET', what: "read the cloud platform's config" },
    authHeaders(env),
  )
  return config?.gatewayBaseUrl ? { AI_GATEWAY_BASE_URL: config.gatewayBaseUrl } : {}
}

export type CloudRunOptions = {
  base: URL
  bundle: MadeBundle
  log: (line: string) => void
  /** Follows the run's event stream and returns its exit code; `attach()` with the run's output. */
  follow: (options: Pick<AttachOptions, 'source' | 'follow' | 'onDetach'>) => Promise<number>
  env?: NodeJS.ProcessEnv
}

/** Creates the run, uploads its bundle, starts it and follows it; returns its exit code. */
export async function runCloud(options: CloudRunOptions): Promise<number> {
  const { base, bundle, log } = options
  const env = options.env ?? process.env
  const headers = authHeaders(env)
  const { archive } = bundle
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const created = await call<{ runId?: unknown; upload?: { url?: unknown; method?: unknown } }>(
    new URL('api/runs', base),
    {
      method: 'POST',
      what: 'create the run',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundleSha256: sha256, bundleBytes: archive.length }),
    },
    headers,
  )
  const runId = created?.runId
  const uploadUrl = typeof created?.upload?.url === 'string' ? URL.parse(created.upload.url) : null
  if (typeof runId !== 'string' || !runId || !uploadUrl) {
    throw new CloudError('the cloud platform created a run without a run id and upload URL')
  }
  const runUrl = (path = '') => new URL(`api/runs/${encodeURIComponent(runId)}${path}`, base)
  // An upload URL on another origin carries its own authorization.
  const uploadHeaders = uploadUrl.origin === base.origin ? headers : {}
  await call(
    uploadUrl,
    {
      method: typeof created.upload?.method === 'string' ? created.upload.method : 'PUT',
      what: `upload the bundle of run ${runId}`,
      headers: { 'content-type': 'application/gzip' },
      body: new Blob([new Uint8Array(archive)]),
      timeoutMs: 10 * 60_000,
    },
    uploadHeaders,
  )
  await call(runUrl('/start'), { method: 'POST', what: `start run ${runId}` }, headers)
  const events = runUrl('/events')
  const reattach = `reeval attach ${displayUrl(events.href)}`
  log(`Started cloud run ${runId}; ${reattach} follows it`)
  let detached = false
  try {
    return await options
      .follow({
        source: events.href,
        ...(headers.authorization && {
          follow: {
            connect: (url) => new WebSocket(url, { headers } as unknown as string[]),
          },
        }),
        onDetach: () => {
          detached = true
        },
      })
      .then((code) => {
        if (!detached) return code
        log(`Cloud run ${runId} goes on: ${reattach} follows it again`)
        return INTERRUPTED
      })
  } catch (error) {
    if (!(error instanceof EventStreamError)) throw error
    const run = await call<PlatformRun>(
      runUrl(),
      { method: 'GET', what: `read run ${runId}` },
      headers,
    ).catch(() => null)
    const why = run?.error?.message ?? run?.error?.code
    if (typeof run?.exitCode === 'number') {
      if (why) log(`cloud run ${runId} ended: ${why}`)
      return run.exitCode
    }
    if (run?.status === 'failed') {
      throw new CloudError(`cloud run ${runId} failed${why ? `: ${why}` : ''}`)
    }
    throw error
  }
}
