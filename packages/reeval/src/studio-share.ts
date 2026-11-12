// `reeval studio share`: a link to a recorded run's view in the cloud studio. It scans the run as
// `reeval cloud push` does, then asks the platform for the share; only when the platform has no
// copy of the run, or hasn't read it yet, does it push it (or wait on the copy being read) and ask
// again. Shares are the report only and for the org's members unless `--full` and `--public` say
// otherwise. `--list` and `--revoke` manage them.
import { setTimeout } from 'node:timers/promises'
import type { Flags } from './cli-spec.ts'
import {
  cloudRunState,
  type PushIo,
  projectUrl,
  type RunState,
  readFailed,
  redirected,
  type ScannedRun,
  scannedRun,
  signedInTarget,
  uploadRun,
  waitRead,
} from './cloud-push.ts'
import { CloudError, platformError, platformMessage, request } from './cloud-run.ts'
import type { Target } from './cloud-secrets.ts'
import { recordedRun } from './commands.ts'
import { UsageError } from './errors.ts'
import { RUN_ID } from './ids.ts'
import type { ResolvedConfig } from './types.ts'

export type Share = {
  id: string
  url: string
  runId: string
  type: 'report' | 'full'
  scope: 'team' | 'public'
  createdAt: string
  revokedAt?: string | null
}

const COMMAND = 'studio share'
/** A share id as the platform makes them; anything else would change the request's path. */
const SHARE_ID = /^[A-Za-z0-9_-]{1,128}$/
/** How long a share asked for right after the run was read waits before it's asked once more. */
const NOT_READY_RETRY_MS = 1_000

const sharesUrl = (t: Target, id?: string) =>
  projectUrl(t, `studio/shares${id ? `/${encodeURIComponent(id)}` : ''}`)

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const isDate = (v: unknown): v is string =>
  typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v))

/**
 * A share as the platform answers it, or null when it isn't one or links somewhere else. Every
 * field it keeps is safe to print, and its url is the normalized link.
 */
function share(body: unknown, t: Target): Share | null {
  const b = body as Partial<Record<keyof Share, unknown>> | null
  if (typeof b !== 'object' || b === null) return null
  if (typeof b.id !== 'string' || !SHARE_ID.test(b.id)) return null
  if (typeof b.runId !== 'string' || !RUN_ID.test(b.runId)) return null
  if (typeof b.url !== 'string' || !isDate(b.createdAt)) return null
  if (b.type !== 'report' && b.type !== 'full') return null
  if (b.scope !== 'team' && b.scope !== 'public') return null
  if (b.revokedAt !== undefined && b.revokedAt !== null && !isDate(b.revokedAt)) return null
  const url = URL.parse(b.url)
  if (!url || url.origin !== t.base.origin || url.username || url.password) return null
  return {
    id: b.id,
    url: url.href,
    runId: b.runId,
    type: b.type,
    scope: b.scope,
    createdAt: b.createdAt,
    ...(b.revokedAt !== undefined && { revokedAt: b.revokedAt as string | null }),
  }
}

type Answer = Awaited<ReturnType<typeof request>>

const errorCode = (answer: Answer) =>
  (answer.body as { error?: { code?: unknown } } | null)?.error?.code

/** One JSON request to the platform's share routes, never following a redirect. */
async function send(
  t: Target,
  url: URL,
  init: { method: string; what: string; body?: unknown },
): Promise<Answer> {
  const answer = await request(
    url,
    {
      method: init.method,
      what: init.what,
      // A redirect would resend the token to wherever it points.
      redirect: 'manual',
      ...(init.body !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(init.body),
      }),
    },
    t.auth.headers,
  )
  if (answer.status >= 300 && answer.status < 400) throw redirected(init.what)
  return answer
}

function refuseMixed(flags: Flags, args: string[]): void {
  const given = (names: Array<keyof Flags>) =>
    names.filter((f) => flags[f] !== undefined).map((f) => `--${f}`)
  if (flags.revoke !== undefined) {
    const extra = [
      ...given(['list', 'full', 'public', 'skip-secret-scan']),
      ...(args.length ? ['a run'] : []),
    ]
    if (extra.length) {
      throw new UsageError(`--revoke takes only the share's id: leave out ${extra.join(', ')}`)
    }
    if (!SHARE_ID.test(flags.revoke)) {
      throw new UsageError(
        "--revoke takes a share's id (letters, digits, - and _), as reeval studio share --list shows it",
      )
    }
  }
  if (flags.list) {
    const extra = given(['full', 'public', 'skip-secret-scan'])
    if (extra.length) {
      throw new UsageError(`--list lists the shares there are: leave out ${extra.join(', ')}`)
    }
  }
  if (flags.public && flags['skip-secret-scan']) {
    throw new UsageError(
      'a public share needs a clean secret scan: leave out --skip-secret-scan, or push the run with reeval cloud push --skip-secret-scan and share it with the team',
    )
  }
}

const listLine = (s: Share) =>
  [
    s.id,
    s.runId,
    s.type,
    s.scope,
    s.createdAt,
    s.revokedAt ? `revoked ${s.revokedAt}` : s.url,
  ].join('  ')

/** Why a `--full` share lacks some transcripts, from the level the run was recorded at. */
function missingTranscripts(run: ScannedRun): string | null {
  if (run.artifacts === 'all') return null
  const which =
    run.artifacts === 'none'
      ? 'no attempt keeps its transcript'
      : "passing attempts' transcripts weren't kept"
  return `Run ${run.runId} was recorded with artifacts ${run.artifacts}, so ${which}: history.artifacts: 'all' or reeval record --artifacts all records every attempt's.`
}

/**
 * Gets the cloud project's copy of `run` read: waits on a copy being read, and uploads the run
 * when there's none or the platform failed to read it. True when it uploaded.
 */
async function ensureRead(
  t: Target,
  run: ScannedRun,
  missing: boolean,
  note: (line: string) => void,
): Promise<boolean> {
  let state: RunState | null = missing ? null : await cloudRunState(t, run.runId)
  let pushed = false
  if (state?.status === 'pending') {
    note(`Waiting for the cloud platform to read run ${run.runId} (revision ${state.revision})`)
    state = await waitRead(t, run.runId, state)
  }
  if (!state || state.status === 'failed') {
    state = await uploadRun(t, run, { wait: true, progress: note })
    pushed = true
  }
  if (state.status === 'failed') throw readFailed(run.runId, state)
  return pushed
}

/** `reeval studio share [run]`, `--list [run]` and `--revoke <id>`; returns the exit code. */
export async function shareCommand(
  config: ResolvedConfig,
  flags: Flags,
  args: string[],
  io: PushIo,
): Promise<number> {
  refuseMixed(flags, args)
  const warn = io.err ?? io.out
  const note = flags.json ? (io.note ?? warn) : io.out
  const t = await signedInTarget(flags, io, COMMAND)

  if (flags.revoke !== undefined) {
    const id = flags.revoke
    const what = `revoke share ${id}`
    const answer = await send(t, sharesUrl(t, id), { method: 'DELETE', what })
    if (!answer.ok) throw platformError(answer, what, t.auth)
    io.out(flags.json ? JSON.stringify({ id, revoked: true }) : `Revoked share ${id}`)
    return 0
  }

  if (flags.list) {
    const ref = args[0]
    const runId =
      ref === undefined
        ? undefined
        : RUN_ID.test(ref)
          ? ref
          : (await recordedRun(config, ref)).runId
    const url = sharesUrl(t)
    if (runId) url.searchParams.set('runId', runId)
    const what = runId ? `list run ${runId}'s shares` : "list the project's shares"
    const answer = await send(t, url, { method: 'GET', what })
    if (!answer.ok) throw platformError(answer, what, t.auth)
    const listed = (answer.body as { shares?: unknown } | null)?.shares
    const shares = Array.isArray(listed) ? listed.map((s) => share(s, t)) : null
    if (!shares || shares.some((s) => s === null)) {
      throw new CloudError(`the cloud platform answered ${what} with something else`)
    }
    const all = shares as Share[]
    if (flags.json) io.out(JSON.stringify({ shares: all }))
    else if (!all.length) io.out(runId ? `Run ${runId} has no shares` : 'No shares in this project')
    else for (const s of all) io.out(listLine(s))
    return 0
  }

  const type = flags.full ? 'full' : 'report'
  const scope = flags.public ? 'public' : 'team'
  const run = await scannedRun(config, flags, args[0], warn)
  const { runId } = run
  if (flags.full) {
    note("This share includes the run's transcripts and artifacts.")
    const missing = missingTranscripts(run)
    if (missing) warn(missing)
  }
  if (flags.public) note('Anyone with the link can view it, without signing in.')
  const what = `share run ${runId}`
  const ask = () => send(t, sharesUrl(t), { method: 'POST', what, body: { runId, type, scope } })
  const notReady = (a: Answer) => a.status === 409 && errorCode(a) === 'not_ready'
  let answer = await ask()
  let pushed = false
  const missing = answer.status === 404 && errorCode(answer) === 'not_found'
  if (missing || notReady(answer)) {
    pushed = await ensureRead(t, run, missing, note)
    answer = await ask()
    if (notReady(answer)) {
      await setTimeout(NOT_READY_RETRY_MS)
      answer = await ask()
      if (notReady(answer)) {
        throw new CloudError(
          `the cloud platform has read run ${runId} but won't share it yet: try again shortly`,
        )
      }
    }
  }
  // The platform's own words, which say what the plan allows.
  if (errorCode(answer) === 'share_limit') {
    throw new UsageError(platformMessage(answer.body) ?? `the cloud platform refused to ${what}`)
  }
  if (!answer.ok) throw platformError(answer, what, t.auth)
  const made = share(answer.body, t)
  if (!made) throw new CloudError(`the cloud platform answered ${what} with something else`)
  if (made.runId !== runId || made.type !== type || made.scope !== scope) {
    throw new CloudError(
      `the cloud platform answered with a different share (${made.id}, ${made.runId}, ${made.type}, ${made.scope}): revoke it with reeval studio share --revoke ${made.id}`,
    )
  }
  if (made.revokedAt) {
    throw new CloudError(
      `the cloud platform answered with a revoked share (${made.id}): ask for the share again`,
    )
  }
  const created = answer.status === 201
  io.out(
    flags.json
      ? JSON.stringify({ ...made, pushed, created })
      : `${created ? 'Shared' : 'Already shared'} ${runId} (${made.type}, ${made.scope}): ${made.url}`,
  )
  return 0
}
