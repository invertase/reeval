// `reeval cloud push`: one recorded run into the cloud project's studio. It zips the run as
// `history.archive` does (the record and its files, with the manifest hashing each), refuses on
// anything the secret scan finds in them, uploads the zip with the stored sign-in and waits until
// the platform has read it, then prints where the studio shows it.
import { rmSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { ArchiveError, writeArchive } from './archive/index.ts'
import { safeZipPath } from './archive/zip.ts'
import type { Flags } from './cli-spec.ts'
import { scanPush } from './cloud-push-scan.ts'
import { CloudError, platformError, request } from './cloud-run.ts'
import { target } from './cloud-secrets.ts'
import { CommandError, recordedRun } from './commands.ts'
import { UsageError } from './errors.ts'
import { readRunArchiveFiles } from './history/files.ts'
import { plural } from './text.ts'
import type { ResolvedConfig } from './types.ts'
import { formatBytes } from './view/debug.ts'

/** How long the push waits for the platform to read the run before it stops waiting. */
const WAIT_MS = 5 * 60_000
const FIRST_POLL_MS = 500
const MAX_POLL_MS = 5_000
/** The upload's time limit: this, plus a second for every 32 KB the archive holds. */
const UPLOAD_BASE_MS = 2 * 60_000
const UPLOAD_BYTES_PER_SECOND = 32 * 1024
const STATUSES = ['pending', 'ready', 'failed'] as const

type RunState = {
  revision: number
  status: (typeof STATUSES)[number]
  error: string | null
}

export type PushIo = {
  out: (line: string) => void
  /** Warnings: what the secret scan found when `--skip-secret-scan` uploads anyway. */
  err?: (line: string) => void
  env?: NodeJS.ProcessEnv
  /** Where `.reeval/project.json` is looked for: the config's directory, else here. */
  projectDir?: string
}

const seg = encodeURIComponent

/** The platform's answer about the run, or null when it isn't one. */
function runState(body: unknown): RunState | null {
  const b = body as Partial<Record<keyof RunState, unknown>> | null
  if (typeof b !== 'object' || b === null) return null
  if (typeof b.revision !== 'number' || !STATUSES.includes(b.status as RunState['status'])) {
    return null
  }
  return {
    revision: b.revision,
    status: b.status as RunState['status'],
    error: typeof b.error === 'string' ? b.error : null,
  }
}

const redirected = (what: string) =>
  new CloudError(
    `the cloud platform redirected the request to ${what} elsewhere, and reeval doesn't send your sign-in on: check REEVAL_CLOUD_URL`,
  )

/**
 * The archive of `files`, built in a temporary folder that is removed once it's read, on an
 * error and on Ctrl-C or SIGTERM.
 */
async function archiveBytes(
  runId: string,
  files: Array<{ path: string; data: Uint8Array }>,
): Promise<Buffer<ArrayBuffer>> {
  const tmp = await mkdtemp(join(tmpdir(), 'reeval-push-'))
  const onSignal = (signal: NodeJS.Signals) => {
    rmSync(tmp, { recursive: true, force: true })
    process.exit(signal === 'SIGTERM' ? 143 : 130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const zip = join(tmp, `${runId}.zip`)
    await writeArchive(zip, { contents: 'run', runId, files }).catch((error: unknown) => {
      if (error instanceof ArchiveError) {
        throw new CommandError(`couldn't archive ${runId}: ${error.message}`)
      }
      throw error
    })
    return await readFile(zip)
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Pushes the recorded run `args[0]` names (default the newest) and returns the exit code. */
export async function pushCommand(
  config: ResolvedConfig,
  flags: Flags,
  args: string[],
  io: PushIo,
): Promise<number> {
  const env = io.env ?? process.env
  const warn = io.err ?? io.out
  const t = await target({ env, projectDir: io.projectDir }, flags, 'cloud push', 'required')
  if (!t.auth.headers.authorization) {
    throw new UsageError(`reeval cloud push needs you signed in: ${t.auth.refused}`)
  }
  const { runId } = await recordedRun(config, args[0] ?? 'latest')
  const files = await readRunArchiveFiles(config.history.dir, runId)
  const { findings, unread, mask } = await scanPush(files)
  const listed = (lines: string[]) => lines.map((l) => `  ${l}`).join('\n')
  if (flags['skip-secret-scan']) {
    if (findings.length) {
      warn(`Pushing ${runId} despite what looks like a secret in:\n${listed(findings)}`)
    }
    if (unread.length)
      warn(`Pushing ${runId} with files the secret scan can't read:\n${listed(unread)}`)
  } else if (findings.length || unread.length) {
    const parts = [
      ...(findings.length
        ? [
            `${plural(findings.length, 'file')} look${findings.length === 1 ? 's' : ''} like ${findings.length === 1 ? 'it holds' : 'they hold'} a secret:\n${listed(findings)}`,
          ]
        : []),
      ...(unread.length
        ? [`the secret scan can't read ${plural(unread.length, 'file')}:\n${listed(unread)}`]
        : []),
    ]
    throw new CommandError(
      `Refusing to push ${runId}: ${parts.join('\nand ')}\nCheck them, then pass --skip-secret-scan to push anyway.`,
    )
  }
  const unsafe = files.find((f) => safeZipPath(f.path) !== f.path)
  if (unsafe) {
    throw new CommandError(
      `${runId} has a file whose name can't go in an archive: ${JSON.stringify(mask(unsafe.path))} (a backslash, an empty, . or .. part, or a NUL). Rename or remove it, then push again.`,
    )
  }
  const runPath = `api/orgs/${seg(t.orgId)}/projects/${seg(t.projectId ?? '')}/studio/runs/${seg(runId)}`
  const url = new URL(runPath, t.base)
  const studio = new URL('studio', t.base)
  studio.searchParams.set('run', runId)
  const body = await archiveBytes(runId, files)
  io.out(`Pushing ${runId}: ${plural(files.length, 'file')}, ${formatBytes(body.length)}`)
  const what = `upload run ${runId}`
  const answer = await request(
    url,
    {
      method: 'PUT',
      what,
      // A redirect would resend the archive, and the token, to wherever it points.
      redirect: 'manual',
      headers: { 'content-type': 'application/zip', 'content-length': String(body.length) },
      body,
      timeoutMs: UPLOAD_BASE_MS + Math.ceil(body.length / UPLOAD_BYTES_PER_SECOND) * 1000,
    },
    t.auth.headers,
  )
  if (answer.status >= 300 && answer.status < 400) throw redirected('the upload')
  if (!answer.ok) throw platformError(answer, what, t.auth)
  let state = runState(answer.body)
  if (!state) {
    throw new CloudError(`the cloud platform took run ${runId} without saying how it stands`)
  }
  const { revision } = state
  if (flags['no-wait']) {
    io.out(`Uploaded revision ${revision}; the studio shows it once it's read: ${studio.href}`)
    return 0
  }
  io.out(`Uploaded revision ${revision}; waiting for the cloud platform to read it`)
  const deadline = Date.now() + WAIT_MS
  const poll = `read how run ${runId} stands`
  let wait = FIRST_POLL_MS
  let problem = ''
  while (state.status === 'pending') {
    if (Date.now() >= deadline) {
      throw new CloudError(
        `run ${runId} still wasn't read after ${WAIT_MS / 60_000} minutes${problem ? ` (last: ${problem})` : ''}; the studio shows it once it is: ${studio.href}`,
      )
    }
    await setTimeout(Math.min(wait, Math.max(0, deadline - Date.now())))
    wait = Math.min(wait * 2, MAX_POLL_MS)
    let polled: Awaited<ReturnType<typeof request>>
    try {
      polled = await request(url, { method: 'GET', what: poll, redirect: 'manual' }, t.auth.headers)
    } catch (error) {
      if (!(error instanceof CloudError)) throw error
      problem = error.message
      continue
    }
    if (polled.status >= 300 && polled.status < 400) throw redirected('the status check')
    const retryable =
      (polled.body as { error?: { retryable?: unknown } } | null)?.error?.retryable === true
    if (polled.status >= 500 || polled.status === 429 || (!polled.ok && retryable)) {
      problem = platformError(polled, poll, t.auth).message
      continue
    }
    if (!polled.ok) throw platformError(polled, poll, t.auth)
    const next = runState(polled.body)
    if (!next) {
      throw new CloudError(
        `the cloud platform answered how run ${runId} stands with something else`,
      )
    }
    state = next
  }
  if (state.status === 'failed') {
    throw new CloudError(
      `the cloud platform couldn't read run ${runId}${state.error ? `: ${state.error}` : ''}`,
    )
  }
  io.out(`Ready: ${studio.href}`)
  return 0
}
