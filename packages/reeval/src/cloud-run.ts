// `reeval run` on the cloud platform. It bundles the project as `reeval bundle` does, creates the
// run at `REEVAL_CLOUD_URL` (https://cloud.reeval.ai when that isn't set), uploads the bundle and
// starts it, then follows the run's event stream as `reeval attach` does and exits with the run's
// exit code. A plan the platform can't run (a sandbox it has no machine for, files a bundle can't
// carry) runs on this machine instead, with a one-line note.
import { createHash } from 'node:crypto'
import type { AttachOptions } from './attach.ts'
import type { MadeBundle } from './bundle/index.ts'
import { type FlagName, type Flags, RUN_FLAGS } from './cli-spec.ts'
import type { LinkedProject } from './cloud-project.ts'
import type { PlannedItem } from './engine/node.ts'
import { UsageError } from './errors.ts'
import { displayUrl, EventStreamError, type FollowOptions } from './events.ts'
import { CLOUD_TOKEN_VAR, type CloudToken, cloudToken } from './login/credentials.ts'
import type { PlanDocument } from './plan.ts'
import { stripCredentials } from './redact.ts'
import { sandboxKind } from './sandbox/kinds.ts'
import { formatDuration, plural } from './text.ts'
import type { ResolvedConfig, ResolvedHistory, ResolvedProfile } from './types.ts'

/** The platform's URL, as the cloud run and `reeval login` read it. */
export const CLOUD_URL_VAR = 'REEVAL_CLOUD_URL'

/** The platform when `REEVAL_CLOUD_URL` isn't set. An explicit value replaces it. */
const DEFAULT_CLOUD_URL = 'https://cloud.reeval.ai'

/** The exit code of a run this terminal detached from, as of one it interrupted. */
const INTERRUPTED = 130

/** A failure of the platform or the way to it: exit 3. */
export class CloudError extends Error {
  override name = 'CloudError'
}

/** A redirect from the platform, which reeval follows nowhere: it would carry the sign-in on. */
export const redirected = (what: string) =>
  new CloudError(
    `the cloud platform redirected the request to ${what} elsewhere, and reeval doesn't send your sign-in on: check REEVAL_CLOUD_URL`,
  )

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
 * The run flags a cloud run takes: the ones its bundle carries (filters aside), `--resume` and the
 * ones that only change how this terminal shows it. `--json` only with `--dry-run`.
 */
const CLOUD_FLAGS = new Set<FlagName>([
  'resume',
  'profile',
  'tag',
  'trait',
  'runs',
  'dry-run',
  'json',
  'cloud',
  'local',
  'download',
  'ui',
  'log-order',
  'log-prefix',
  'force',
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

/**
 * The platform's URL, with a trailing `/`: `REEVAL_CLOUD_URL` when it's set, else
 * `https://cloud.reeval.ai`. Exit 2 when the value isn't an http(s) URL or carries a user name
 * or password.
 */
export function cloudUrl(env: NodeJS.ProcessEnv = process.env): URL {
  const raw = env[CLOUD_URL_VAR]?.trim() || DEFAULT_CLOUD_URL
  const url = URL.parse(raw)
  if (!url || !/^https?:$/.test(url.protocol)) {
    throw new UsageError(`${CLOUD_URL_VAR} is an http or https URL (got ${stripCredentials(raw)})`)
  }
  if (url.username || url.password) {
    throw new UsageError(
      `${CLOUD_URL_VAR} can't carry a user name or password (got ${stripCredentials(raw)}): sign in with reeval login, or set ${CLOUD_TOKEN_VAR}`,
    )
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

/**
 * The platform's URL as reeval prints it, in text and JSON: `cloudUrl`'s without the trailing
 * `/` (`https://cloud.reeval.ai`), however `REEVAL_CLOUD_URL` spells it.
 */
export const shownCloudUrl = (base: URL) => base.href.replace(/\/$/, '')

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

/** What every platform request carries, and what to do when the platform refuses it. */
export type CloudAuth = {
  /** The bearer token, when there is one. */
  headers: Record<string, string>
  /** The fix for a 401 or 403, which depends on where the token came from; empty for none. */
  refused: string
}

/** What to do when the platform refuses `token`, or no token at all. */
export function refusedHint(token: CloudToken | null): string {
  if (token?.from === 'env') return `check ${CLOUD_TOKEN_VAR}`
  if (token) return 'reeval login signs in again'
  return `reeval login signs in, or set ${CLOUD_TOKEN_VAR}`
}

/** The platform's bearer token: `REEVAL_TOKEN` when it's set, else the one `reeval login` stored. */
export async function cloudAuth(
  base: URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CloudAuth> {
  const token = await cloudToken(base, env)
  return {
    headers: token ? { authorization: `Bearer ${token.token}` } : {},
    refused: refusedHint(token),
  }
}

/**
 * How `reeval attach` follows `source`: with the bearer token when it's the cloud platform's,
 * else as any other stream.
 */
export async function cloudFollow(
  source: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FollowOptions | undefined> {
  let platform: URL
  try {
    platform = cloudUrl(env)
  } catch {
    return undefined
  }
  const url = URL.parse(source)
  if (!url) return undefined
  const origin = (u: URL) => `${u.protocol.replace(/^ws/, 'http')}//${u.host}`
  if (origin(platform) !== origin(url)) return undefined
  const { headers } = await cloudAuth(platform, env)
  if (!headers.authorization) return undefined
  return { connect: (u) => new WebSocket(u, { headers } as unknown as string[]) }
}

type PlatformRun = {
  id: string
  status: string
  error?: { code: string; message: string } | null
  exitCode?: number | null
}

/** The exit code of a run the platform stopped before it finished. */
const STOPPED = 4

/** How long a cloud run's status is waited for once its stream has ended or been lost. */
const STATUS_TIMEOUT_MS = 5_000

/** A field of the platform's answer as it may reach a terminal; empty when it isn't a string. */
const platformText = (value: unknown) => (typeof value === 'string' ? printable(value) : '')

/**
 * Cloud run `runId` as the platform has it; null when it doesn't answer within
 * `STATUS_TIMEOUT_MS`, refuses, or a Ctrl-C or SIGTERM cuts the wait short.
 */
async function readRun(runId: string, base: URL, auth: CloudAuth): Promise<PlatformRun | null> {
  const stop = new AbortController()
  const abort = () => stop.abort()
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  try {
    return await call<PlatformRun>(
      new URL(`api/runs/${encodeURIComponent(runId)}`, base),
      {
        method: 'GET',
        what: `read run ${runId}`,
        timeoutMs: STATUS_TIMEOUT_MS,
        signal: stop.signal,
      },
      auth,
    )
  } catch {
    return null
  } finally {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
}

/**
 * `code`, the exit code cloud run `runId`'s stream ended with, or 4 when the platform says it
 * stopped the run before it finished. A stop can end the stream with any code (a cancel's, or
 * what the attempts it cut short left), so every run that ended is asked about, unless `read` is
 * the platform's answer already. An answer that doesn't come keeps the stream's code.
 */
export async function stoppedOr(
  code: number,
  runId: string,
  base: URL,
  auth: CloudAuth,
  log: (line: string) => void,
  read?: PlatformRun | null,
): Promise<number> {
  const run = read !== undefined ? read : await readRun(runId, base, auth)
  if (run?.status !== 'stopped') return code
  const why = platformText(run.error?.message) || platformText(run.error?.code)
  log(
    why
      ? `Cloud run ${runId} stopped: ${why}`
      : `The cloud platform stopped run ${runId} before it finished`,
  )
  log(`reeval run --cloud --resume ${runId} continues it`)
  return STOPPED
}

/**
 * When following cloud run `runId` lost its stream (`lost`): the exit code the platform recorded
 * for it, with the run as read, which `stoppedOr` takes. Throws `lost` when the platform has no
 * exit code and the run neither failed nor was stopped there. A `resumed` run's recorded code can
 * be the one it stopped with before, so it counts only once the run has ended again.
 */
export async function afterLostStream(
  lost: EventStreamError,
  runId: string,
  base: URL,
  auth: CloudAuth,
  log: (line: string) => void,
  resumed = false,
): Promise<{ code: number; read: PlatformRun | null }> {
  const run = await readRun(runId, base, auth)
  const why = platformText(run?.error?.message) || platformText(run?.error?.code)
  const ended = run?.status === 'succeeded' || run?.status === 'cancelled'
  const exitCode =
    typeof run?.exitCode === 'number' && (!resumed || ended) ? run.exitCode : undefined
  if (run?.status === 'stopped') return { code: exitCode ?? INTERRUPTED, read: run }
  if (exitCode === undefined) {
    if (run?.status === 'failed') {
      throw new CloudError(`cloud run ${runId} failed${why ? `: ${why}` : ''}`)
    }
    throw lost
  }
  if (why) log(`cloud run ${runId} ended: ${why}`)
  return { code: exitCode, read: run }
}

/** How the interactive list says to cancel cloud run `runId`, which no key there reaches. */
export const cancelHint = (runId: string) => `reeval cloud run cancel ${runId} cancels it`

/** A cloud run's id, from the id itself or its event stream URL on the platform at `base`. */
async function cloudRunId(given: string, base: URL): Promise<string> {
  let runId = given
  if (/^(https?|wss?):\/\//i.test(given)) {
    const { cloudRunOf } = await import('./cloud-files.ts')
    const run = cloudRunOf(given, base)
    if (!run) {
      throw new UsageError(
        `${printable(displayUrl(given))} isn't a cloud run's event stream at ${displayUrl(base.href)}: pass the run's id, or its URL there (${displayUrl(base.href)}api/runs/<run>/events)`,
      )
    }
    runId = run.runId
  }
  if (printable(runId) !== runId) {
    throw new UsageError(
      `"${printable(runId)}" isn't a cloud run's id: it holds control characters`,
    )
  }
  return runId
}

/** `reeval cloud run cancel <run>`: asks the platform to cancel the run. */
export async function cloudRunCommand(
  args: string[],
  io: { out: (line: string) => void },
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [action, given] = args
  if (action !== 'cancel') {
    throw new UsageError(
      `Unknown command "${['cloud', 'run', action].filter(Boolean).join(' ')}". Did you mean reeval cloud run cancel <run>?`,
    )
  }
  if (!given) {
    throw new UsageError(
      'reeval cloud run cancel needs the run: the id reeval run --cloud printed, or its event stream URL',
    )
  }
  const base = cloudUrl(env)
  const runId = await cloudRunId(given, base)
  const auth = await cloudAuth(base, env)
  const what = `cancel run ${runId}`
  const answer = await request(
    new URL(`api/runs/${encodeURIComponent(runId)}/cancel`, base),
    { method: 'POST', what },
    auth.headers,
  )
  if (!answer.ok) throw platformError(answer, what, auth)
  const run = answer.body as PlatformRun | null
  if (answer.status === 202) {
    io.out(`Canceling cloud run ${runId}; its followers see it end once it stops`)
  } else {
    const said = platformText(run?.status)
    const status = said ? ` (${said})` : ''
    io.out(`Cloud run ${runId} has already ended${status}`)
  }
  return 0
}

export type CallInit = RequestInit & { what: string; timeoutMs?: number }

/** One request to the platform, JSON in and out, whatever its status; exit 3 when it doesn't answer. */
export async function request(
  url: URL,
  init: CallInit,
  headers: Record<string, string>,
): Promise<{ status: number; ok: boolean; body: unknown; headers: Headers }> {
  const { what, timeoutMs = 30_000, ...rest } = init
  let res: Response
  try {
    res = await fetch(url, {
      ...rest,
      headers: { accept: 'application/json', ...headers, ...rest.headers },
      signal: rest.signal
        ? AbortSignal.any([AbortSignal.timeout(timeoutMs), rest.signal])
        : AbortSignal.timeout(timeoutMs),
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
  return { status: res.status, ok: res.ok, body, headers: res.headers }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** Text from the platform as it may reach a terminal: no escape sequences from its side. */
export const printable = (text: string) => text.replace(CONTROL, '')

/** The platform's own words for a refusal, in any of the shapes its routes answer with. */
export function platformMessage(body: unknown): string | undefined {
  const b = body as {
    error?: unknown
    error_description?: unknown
    message?: unknown
  } | null
  const nested = (b?.error as { message?: unknown } | null | undefined)?.message
  for (const said of [nested, b?.error_description, b?.message, b?.error]) {
    if (typeof said !== 'string') continue
    const clean = printable(said)
    if (clean) return clean
  }
  return undefined
}

/** The error for a platform answer that isn't ok: a refusal (4xx) exits 2, any other failure 3. */
export function platformError(
  answer: { status: number; body: unknown },
  what: string,
  auth: Pick<CloudAuth, 'refused'>,
): Error {
  const { status, body } = answer
  const said = platformMessage(body)
  const hint = (status === 401 || status === 403) && auth.refused ? ` (${auth.refused})` : ''
  const why = `${said ?? `HTTP ${status}`}${hint}`
  return status >= 400 && status < 500
    ? new UsageError(`the cloud platform refused to ${what}: ${why}`)
    : new CloudError(`couldn't ${what}: ${why}`)
}

/** One request to the platform, JSON in and out; a refusal (4xx) exits 2, any other failure 3. */
export async function call<T>(url: URL, init: CallInit, auth: CloudAuth): Promise<T> {
  const answer = await request(url, init, auth.headers)
  if (!answer.ok) throw platformError(answer, init.what, auth)
  return answer.body as T
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
    await cloudAuth(base, env),
  )
  return config?.gatewayBaseUrl ? { AI_GATEWAY_BASE_URL: config.gatewayBaseUrl } : {}
}

export type CloudRunOptions = {
  base: URL
  bundle: MadeBundle
  log: (line: string) => void
  /** Follows the run's event stream and returns its exit code; `attach()` with the run's output. */
  follow: (
    options: Pick<AttachOptions, 'source' | 'follow' | 'onDetach' | 'cancelHint' | 'resumedAfter'>,
  ) => Promise<number>
  /**
   * `--download`: once the run ends, its files go into this project as a run here leaves them,
   * a recorded run's into `history`; `profile` is the profile that picked it.
   */
  download?: { root: string; history: ResolvedHistory; profile?: string }
  /** The project `reeval link` linked, which the run is created in. */
  project: LinkedProject
  /** Asks a yes-or-no question; unset when there's no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean>
  /** `--force`: runs without the `.env` names the linked project lacks, without asking. */
  force?: boolean
  env?: NodeJS.ProcessEnv
}

/**
 * Stops the run, naming them, when the linked project lacks the manifest's `secrets` or holds a
 * name the platform sets itself, against the names it says a run there gets. A loaded `.env`
 * file's variables are optional there: the run gets each one the project has, so for the ones it
 * lacks this asks before going on (`force` goes on without asking; with no terminal to ask on it
 * stops), and a reserved one is only noted. The platform checks again when the run starts, so a
 * platform that can't list the names skips this check, with a line under `REEVAL_DEBUG`.
 */
export async function checkCloudSecrets(options: {
  base: URL
  auth: CloudAuth
  project: LinkedProject
  manifest: Pick<MadeBundle['manifest'], 'secrets' | 'envFiles'>
  log: (line: string) => void
  /** Asks a yes-or-no question; unset when there's no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean>
  force?: boolean
  env?: NodeJS.ProcessEnv
}): Promise<void> {
  const { base, auth, project, manifest, log } = options
  const env = options.env ?? process.env
  const skip = (why: string) => {
    if (env.REEVAL_DEBUG) console.error(`cloud: secrets check skipped: ${why}`)
  }
  if (!auth.headers.authorization) return skip('not signed in')
  const required = [...new Set(manifest.secrets)].sort()
  const fromFile = new Map<string, string>()
  for (const file of manifest.envFiles) {
    for (const name of file.variables) {
      if (!required.includes(name) && !fromFile.has(name)) fromFile.set(name, file.path)
    }
  }
  const needed = [...required, ...fromFile.keys()].sort()
  if (!needed.length) return
  const seg = encodeURIComponent
  const projectPath = `api/orgs/${seg(project.orgId)}/projects/${seg(project.projectId)}`
  let answer: Awaited<ReturnType<typeof request>>
  try {
    answer = await request(
      new URL(`${projectPath}/secret-names?reserved=${needed.map(seg).join(',')}`, base),
      {
        method: 'GET',
        what: "list the project's secret names",
        redirect: 'error',
        timeoutMs: 15_000,
      },
      auth.headers,
    )
  } catch (error) {
    return skip((error as Error).message)
  }
  if (!answer.ok) return skip(`HTTP ${answer.status}`)
  const body = answer.body as { names?: unknown; reserved?: unknown } | null
  const strings = (x: unknown): x is string[] =>
    Array.isArray(x) && x.every((n) => typeof n === 'string')
  if (!strings(body?.names)) return skip('the answer has no list of names')
  const held = new Set(body.names)
  const reserved = new Set(strings(body.reserved) ? body.reserved : [])
  const list = (names: string[]) => names.map((name) => `  ${name}`).join('\n')
  const missing = required.filter((name) => !held.has(name))
  if (missing.length) {
    const settable = missing.filter((name) => !reserved.has(name))
    const refused = missing.filter((name) => reserved.has(name))
    const one = missing.length === 1
    const parts = [
      `The cloud project ${await projectLabel(base, auth, project)} lacks ${one ? 'a secret' : `${missing.length} secrets`} this run needs, so nothing was uploaded:`,
    ]
    if (settable.length) {
      parts.push(
        list(settable),
        `Add ${settable.length === 1 ? 'it' : 'each'} with ${SET_HINT}. Then run again.`,
      )
    }
    if (refused.length) {
      parts.push(
        `${settable.length ? 'And the' : 'The'} cloud platform sets ${refused.length === 1 ? 'this name' : 'these names'} itself, so no cloud run can take ${refused.length === 1 ? 'it' : 'them'} as a secret: rename ${refused.length === 1 ? 'it' : 'them'} in the eval.`,
        list(refused),
      )
    }
    throw new UsageError(parts.join('\n'))
  }
  const local = [...fromFile.keys()].filter((name) => !held.has(name)).sort()
  const unsent = local.filter((name) => reserved.has(name))
  if (unsent.length) {
    log(
      `cloud: ${unsent.map((name) => `${name} (from ${fromFile.get(name)})`).join(', ')} won't be sent: the cloud platform sets ${unsent.length === 1 ? 'this name' : 'these names'} itself`,
    )
  }
  const lacking = local.filter((name) => !reserved.has(name))
  if (!lacking.length) return
  const question = `Cloud environment does not have the following secrets you have locally defined:\n${list(lacking)}\n`
  if (options.force) {
    log(
      `cloud: running without ${lacking.join(', ')}, which only this machine's .env files set (--force)`,
    )
    return
  }
  if (!options.confirm) {
    throw new UsageError(
      `${question}Nothing was uploaded. Pass --force to run without ${lacking.length === 1 ? 'it' : 'them'}, or add ${lacking.length === 1 ? 'it' : 'each'} with ${SET_HINT}.`,
    )
  }
  if (!(await options.confirm(`${question}\nDo you want to continue? [y/N] `))) {
    throw new UsageError('Stopped: nothing was uploaded.')
  }
}

const SET_HINT =
  'reeval cloud secrets set <name> --from-env, which reads its value from this shell, or leave out --from-env to type it; give --host <host> for a brokered one, or --mode sandbox or --mode readable'

/** The linked project's name and slug, as the platform lists it; its id when it can't. */
async function projectLabel(base: URL, auth: CloudAuth, project: LinkedProject): Promise<string> {
  try {
    const { label, listProjects } = await import('./cloud-project.ts')
    const projects = await listProjects(
      (path, what) => call(new URL(path, base), { method: 'GET', what, redirect: 'error' }, auth),
      { id: project.orgId, slug: project.orgId, name: '' },
    )
    const found = projects.find((p) => p.id === project.projectId)
    return found ? label(found) : project.projectId
  } catch {
    return project.projectId
  }
}

/** Creates the run, uploads its bundle, starts it and follows it; returns its exit code. */
export async function runCloud(options: CloudRunOptions): Promise<number> {
  const { base, bundle, log } = options
  const env = options.env ?? process.env
  const auth = await cloudAuth(base, env)
  const { headers } = auth
  const { archive } = bundle
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const { project } = options
  await checkCloudSecrets({
    base,
    auth,
    project,
    manifest: bundle.manifest,
    log,
    ...(options.confirm && { confirm: options.confirm }),
    ...(options.force && { force: true }),
    env,
  })
  const what = 'create the run'
  const answer = await request(
    new URL(
      `api/orgs/${encodeURIComponent(project.orgId)}/projects/${encodeURIComponent(project.projectId)}/runs`,
      base,
    ),
    {
      method: 'POST',
      what,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundleSha256: sha256, bundleBytes: archive.length }),
    },
    headers,
  )
  if (answer.status === 403 || answer.status === 404) {
    throw new UsageError(
      `the cloud platform refused to create the run in ${project.projectId}, the project reeval link linked: ${platformMessage(answer.body) ?? `HTTP ${answer.status}`} (reeval link links another)`,
    )
  }
  if (!answer.ok) throw platformError(answer, what, auth)
  const created = answer.body as {
    runId?: unknown
    upload?: { url?: unknown; method?: unknown }
  } | null
  const runId = created?.runId
  const uploadUrl = typeof created?.upload?.url === 'string' ? URL.parse(created.upload.url) : null
  if (typeof runId !== 'string' || !runId || !uploadUrl) {
    throw new CloudError('the cloud platform created a run without a run id and upload URL')
  }
  const runUrl = (path = '') => new URL(`api/runs/${encodeURIComponent(runId)}${path}`, base)
  // An upload URL on another origin carries its own authorization.
  const uploadAuth = uploadUrl.origin === base.origin ? auth : { ...auth, headers: {} }
  await call(
    uploadUrl,
    {
      method: typeof created.upload?.method === 'string' ? created.upload.method : 'PUT',
      what: `upload the bundle of run ${runId}`,
      headers: { 'content-type': 'application/gzip' },
      body: new Blob([new Uint8Array(archive)]),
      timeoutMs: 10 * 60_000,
    },
    uploadAuth,
  )
  await call(runUrl('/start'), { method: 'POST', what: `start run ${runId}` }, auth)
  return followCloudRun(options, runId, auth, 'Started cloud run')
}

/**
 * Follows cloud run `runId` from its event stream's start, after `lead` (`Started cloud run`) and
 * the run's id, and returns its exit code: 130 once this terminal detaches, 4 when the platform
 * stopped it, else the stream's. With `download`, its files follow once it ends.
 */
async function followCloudRun(
  options: Pick<CloudRunOptions, 'base' | 'log' | 'follow' | 'download'>,
  runId: string,
  auth: CloudAuth,
  lead: string,
  resumedAfter?: number,
): Promise<number> {
  const { base, log } = options
  const { headers } = auth
  const runUrl = (path = '') => new URL(`api/runs/${encodeURIComponent(runId)}${path}`, base)
  const events = runUrl('/events')
  const reattach = `reeval attach ${displayUrl(events.href)}`
  log(`${lead} ${runId}; ${reattach} follows it`)
  let detached = false
  let code: number
  let read: PlatformRun | null | undefined
  try {
    code = await options.follow({
      source: events.href,
      ...(headers.authorization && {
        follow: {
          connect: (url) => new WebSocket(url, { headers } as unknown as string[]),
        },
      }),
      onDetach: () => {
        detached = true
      },
      cancelHint: cancelHint(runId),
      ...(resumedAfter === undefined ? {} : { resumedAfter }),
    })
  } catch (error) {
    if (!(error instanceof EventStreamError)) throw error
    const resumed = resumedAfter !== undefined
    ;({ code, read } = await afterLostStream(error, runId, base, auth, log, resumed))
  }
  if (detached) {
    const again = options.download
      ? `reeval attach --download${options.download.profile === undefined ? '' : ` --profile ${options.download.profile}`} ${displayUrl(events.href)} follows it again and downloads its files once it ends`
      : `${reattach} follows it again`
    log(`Cloud run ${runId} goes on: ${again}; ${cancelHint(runId)}`)
    return INTERRUPTED
  }
  code = await stoppedOr(code, runId, base, auth, log, read)
  if (options.download) {
    const { downloadAfter, downloadCloudFiles } = await import('./cloud-files.ts')
    const { root, history } = options.download
    const lines = await downloadAfter(code, runId, () =>
      downloadCloudFiles({
        cloudRunId: runId,
        url: runUrl('/artifacts/files.tar.gz'),
        auth,
        root,
        history,
      }),
    )
    for (const line of lines) log(line)
  }
  return code
}

/** How long a resume waits for a run that's still stopping before it gives up. */
const STILL_STOPPING_MS = 5 * 60_000

/** The wait a `Retry-After` header asks for, in seconds or as a date; 5 s without one. */
function retryAfterMs(header: string | null, now: number): number {
  const value = header?.trim() ?? ''
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? 5_000 : Math.max(0, at - now)
}

/** The `code` of the platform's error answer, when it has one. */
const errorCode = (body: unknown) => {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code
  return typeof code === 'string' ? code : undefined
}

type Answer = Awaited<ReturnType<typeof request>>

/**
 * Asks the platform to resume cloud run `runId` with `post`, again after each `still_stopping`
 * answer for as long as its `Retry-After` says, for up to `windowMs` in all, saying so once.
 * Returns the first other answer; exit 3 when the run is still stopping at the end.
 */
export async function askToResume(
  post: () => Promise<Answer>,
  runId: string,
  log: (line: string) => void,
  {
    windowMs = STILL_STOPPING_MS,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: { windowMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Answer> {
  const until = now() + windowMs
  const window =
    windowMs % 60_000 === 0 ? plural(windowMs / 60_000, 'minute') : formatDuration(windowMs)
  let said = false
  for (;;) {
    const answer = await post()
    if (answer.status !== 409 || errorCode(answer.body) !== 'still_stopping') return answer
    const left = until - now()
    if (left <= 0) {
      throw new CloudError(
        `cloud run ${runId} is still stopping after ${window}: reeval run --cloud --resume ${runId} tries again`,
      )
    }
    if (!said) {
      log(`Cloud run ${runId} is still stopping: waiting up to ${window} to resume it`)
      said = true
    }
    await sleep(
      Math.min(Math.max(retryAfterMs(answer.headers.get('retry-after'), now()), 1_000), left),
    )
  }
}

export type CloudResumeOptions = Pick<CloudRunOptions, 'base' | 'log' | 'follow' | 'download'> & {
  /** The run: its id, as `reeval run --cloud` printed it, or its event stream URL. */
  run: string
  /** Whether a project's config is in sight, whose changes the resume doesn't take. */
  checkout: boolean
  /** The run was looked for here first, so an unknown one is unknown in both places. */
  lookedHere?: boolean
  env?: NodeJS.ProcessEnv
}

/**
 * `reeval run --cloud --resume <run>`: asks the platform to resume the run, which runs the project
 * as it was uploaded, then follows it as `runCloud` does once a run has started. Only lines after
 * the ones the run had already count toward its exit code.
 */
export async function resumeCloud(options: CloudResumeOptions): Promise<number> {
  const { base, log } = options
  const env = options.env ?? process.env
  const runId = await cloudRunId(options.run, base)
  const auth = await cloudAuth(base, env)
  const runUrl = (path = '') => new URL(`api/runs/${encodeURIComponent(runId)}${path}`, base)
  const read = await request(runUrl(), { method: 'GET', what: `read run ${runId}` }, auth.headers)
  if (read.status === 404 && options.lookedHere) {
    throw new UsageError(
      `No run matches "${runId}" here or in the cloud. Pass a run id, or a cloud run's id as reeval run --cloud printed it.`,
    )
  }
  if (!read.ok) throw platformError(read, `read run ${runId}`, auth)
  const seen = read.body as (PlatformRun & { segment?: unknown }) | null
  const segment = typeof seen?.segment === 'number' ? { fromSegment: seen.segment } : {}
  const what = `resume run ${runId}`
  const answer = await askToResume(
    () =>
      request(
        runUrl('/resume'),
        {
          method: 'POST',
          what,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(segment),
        },
        auth.headers,
      ),
    runId,
    log,
  )
  if (answer.status === 409 && errorCode(answer.body) === 'not_resumable') {
    if (seen?.status === 'succeeded') {
      throw new UsageError(
        `run ${runId} is complete and cannot be resumed; reeval run --cloud starts a new run`,
      )
    }
    const why = platformMessage(answer.body)
    throw new UsageError(`the cloud platform can't resume run ${runId}${why ? `: ${why}` : ''}`)
  }
  if (!answer.ok) throw platformError(answer, what, auth)
  if (options.checkout) {
    log(
      `Resuming cloud run ${runId} with the project as it was uploaded, without changes made here since; reeval run --cloud starts a new run`,
    )
  }
  const lead = answer.status === 202 ? 'Resumed cloud run' : 'Already resuming cloud run'
  // Each start of the run, counted from 0, begins with a header of its own in the stream.
  const now = (answer.body as { segment?: unknown } | null)?.segment
  const before =
    typeof now === 'number'
      ? now
      : typeof seen?.segment === 'number'
        ? seen.segment + (answer.status === 202 ? 1 : 0)
        : 0
  return followCloudRun(options, runId, auth, lead, before)
}
