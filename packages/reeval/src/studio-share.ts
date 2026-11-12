// `reeval studio share`: a link to a recorded run's view in the cloud studio. It pushes the run as
// `reeval cloud push` does, secret scan included, unless the cloud project has read it already,
// then asks the platform for the share. Shares are the report only and for the org's members
// unless `--full` and `--public` say otherwise. `--list` and `--revoke` manage them.
import type { Flags } from './cli-spec.ts'
import {
  cloudRunState,
  type PushIo,
  readFailed,
  scannedRun,
  signedInTarget,
  uploadRun,
} from './cloud-push.ts'
import { CloudError, platformError, platformMessage, request } from './cloud-run.ts'
import type { Target } from './cloud-secrets.ts'
import { recordedRun } from './commands.ts'
import { UsageError } from './errors.ts'
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
const seg = encodeURIComponent

const sharesUrl = (t: Target, id?: string) =>
  new URL(
    `api/orgs/${seg(t.orgId)}/projects/${seg(t.projectId ?? '')}/studio/shares${id ? `/${seg(id)}` : ''}`,
    t.base,
  )

function share(body: unknown): Share | null {
  const b = body as Partial<Record<keyof Share, unknown>> | null
  if (typeof b !== 'object' || b === null) return null
  const strings = ['id', 'url', 'runId', 'createdAt'] as const
  if (!strings.every((k) => typeof b[k] === 'string')) return null
  if (b.type !== 'report' && b.type !== 'full') return null
  if (b.scope !== 'team' && b.scope !== 'public') return null
  return {
    id: b.id as string,
    url: b.url as string,
    runId: b.runId as string,
    type: b.type,
    scope: b.scope,
    createdAt: b.createdAt as string,
    ...(b.revokedAt !== undefined && {
      revokedAt: typeof b.revokedAt === 'string' ? b.revokedAt : null,
    }),
  }
}

/** One JSON request to the platform's share routes, never following a redirect. */
async function send(t: Target, url: URL, init: { method: string; what: string; body?: unknown }) {
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
  if (answer.status >= 300 && answer.status < 400) {
    throw new CloudError(
      `the cloud platform redirected the request to ${init.what} elsewhere, and reeval doesn't send your sign-in on: check REEVAL_CLOUD_URL`,
    )
  }
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
    if (!flags.revoke) throw new UsageError("--revoke needs the share's id")
  }
  if (flags.list) {
    const extra = given(['full', 'public', 'skip-secret-scan'])
    if (extra.length) {
      throw new UsageError(`--list lists the shares there are: leave out ${extra.join(', ')}`)
    }
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
    const runId = args[0] === undefined ? undefined : (await recordedRun(config, args[0])).runId
    const url = sharesUrl(t)
    if (runId) url.searchParams.set('runId', runId)
    const what = runId ? `list run ${runId}'s shares` : "list the project's shares"
    const answer = await send(t, url, { method: 'GET', what })
    if (!answer.ok) throw platformError(answer, what, t.auth)
    const listed = (answer.body as { shares?: unknown } | null)?.shares
    const shares = Array.isArray(listed) ? listed.map(share) : null
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
  if (flags.full) note("This share includes the run's transcripts and artifacts.")
  if (flags.public) note('Anyone with the link can view it, without signing in.')
  const there = await cloudRunState(t, runId)
  let pushed = false
  if (there?.status === 'ready') {
    note(`The cloud project has run ${runId} already (revision ${there.revision})`)
  } else {
    const state = await uploadRun(t, run, { wait: true, progress: note })
    if (state.status === 'failed') throw readFailed(runId, state)
    pushed = true
  }
  const what = `share run ${runId}`
  const answer = await send(t, sharesUrl(t), {
    method: 'POST',
    what,
    body: { runId, type, scope },
  })
  // The platform's own words, which say what the plan allows.
  if (answer.status === 402) {
    throw new UsageError(platformMessage(answer.body) ?? `the cloud platform refused to ${what}`)
  }
  if (!answer.ok) throw platformError(answer, what, t.auth)
  const made = share(answer.body)
  if (!made) throw new CloudError(`the cloud platform answered ${what} with something else`)
  io.out(
    flags.json
      ? JSON.stringify({ ...made, pushed })
      : `${answer.status === 200 ? 'Already shared' : 'Shared'} ${runId} (${made.type}, ${made.scope}): ${made.url}`,
  )
  return 0
}
