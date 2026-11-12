// `reeval cloud push`: one recorded run into the cloud project's studio. It zips the run as
// `history.archive` does (the record and its files, with the manifest hashing each), refuses on
// anything the secret scan finds in them, uploads the zip with the stored sign-in and waits until
// the platform has read it, then prints where the studio shows it.
import { openAsBlob } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { writeArchive } from './archive/index.ts'
import type { Flags } from './cli-spec.ts'
import { CloudError, call, platformError, request } from './cloud-run.ts'
import { target } from './cloud-secrets.ts'
import { CommandError, recordedRun } from './commands.ts'
import { UsageError } from './errors.ts'
import { recordFile, runArchiveFiles } from './history/files.ts'
import { type Finding, scanText } from './history/secret-scan.ts'
import { plural } from './text.ts'
import type { ResolvedConfig } from './types.ts'
import { formatBytes } from './view/debug.ts'

/** How long the push waits for the platform to read the run before it stops waiting. */
const WAIT_MS = 5 * 60_000
const FIRST_POLL_MS = 500
const MAX_POLL_MS = 5_000
/** Findings named per file; the rest are counted. */
const SHOWN = 3

type RunState = {
  runId: string
  revision: number
  status: 'pending' | 'ready' | 'failed'
  error: string | null
}

export type PushIo = {
  out: (line: string) => void
  env?: NodeJS.ProcessEnv
  /** Where `.reeval/project.json` is looked for: the config's directory, else here. */
  projectDir?: string
}

const seg = encodeURIComponent

/** Where each finding is and which rule it matched, never any part of the value. */
function findingText(path: string, findings: Finding[]): string {
  const shown = findings.slice(0, SHOWN).map((f) => {
    const where = [f.file, f.line === null ? null : `line ${f.line}`].filter(Boolean).join(' ')
    return `${where ? `${where}: ` : ''}${f.rule}`
  })
  const more = findings.length > SHOWN ? `, and ${findings.length - SHOWN} more` : ''
  return `${path}: ${shown.join('; ')}${more}`
}

/** A file that reads as text: no NUL in its first 8000 bytes, as git tells binary. */
const isText = (data: Uint8Array) => !Buffer.from(data.subarray(0, 8000)).includes(0)

/** Pushes the recorded run `args[0]` names (default the newest) and returns the exit code. */
export async function pushCommand(
  config: ResolvedConfig,
  flags: Flags,
  args: string[],
  io: PushIo,
): Promise<number> {
  const env = io.env ?? process.env
  const t = await target({ env, projectDir: io.projectDir }, flags, 'cloud push', 'required')
  if (!t.auth.headers.authorization) {
    throw new UsageError(`reeval cloud push needs you signed in: ${t.auth.refused}`)
  }
  const { runId } = await recordedRun(config, args[0] ?? 'latest')
  const dir = config.history.dir
  const record = await readFile(recordFile(dir, runId))
  const files = await runArchiveFiles(dir, runId, record)
  if (!flags['skip-secret-scan']) {
    const found = files.flatMap(({ path, data }) => {
      if (!isText(data)) return []
      const findings = scanText(path, Buffer.from(data).toString('utf8'))
      return findings.length ? [findingText(path, findings)] : []
    })
    if (found.length) {
      throw new CommandError(
        `Refusing to push ${runId}: ${plural(found.length, 'file')} look${found.length === 1 ? 's' : ''} like ${found.length === 1 ? 'it holds' : 'they hold'} a secret:\n${found.map((l) => `  ${l}`).join('\n')}\nCheck them, then pass --skip-secret-scan if these are false positives.`,
      )
    }
  }
  const runPath = `api/orgs/${seg(t.orgId)}/projects/${seg(t.projectId ?? '')}/studio/runs/${seg(runId)}`
  const url = new URL(runPath, t.base)
  const studio = new URL('studio', t.base)
  studio.searchParams.set('run', runId)
  const tmp = await mkdtemp(join(tmpdir(), 'reeval-push-'))
  let state: RunState
  try {
    const zip = join(tmp, `${runId}.zip`)
    await writeArchive(zip, { contents: 'run', runId, files })
    const body = await openAsBlob(zip, { type: 'application/zip' })
    io.out(`Pushing ${runId}: ${plural(files.length, 'file')}, ${formatBytes(body.size)}`)
    const what = `upload run ${runId}`
    const answer = await request(
      url,
      {
        method: 'PUT',
        what,
        // A redirect would resend the archive, and the token, to wherever it points.
        redirect: 'error',
        headers: { 'content-type': 'application/zip', 'content-length': String(body.size) },
        body,
        timeoutMs: 10 * 60_000,
      },
      t.auth.headers,
    )
    if (!answer.ok) throw platformError(answer, what, t.auth)
    state = answer.body as RunState
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
  if (typeof state?.revision !== 'number' || typeof state.status !== 'string') {
    throw new CloudError(`the cloud platform took run ${runId} without saying how it stands`)
  }
  const { revision } = state
  if (flags['no-wait']) {
    io.out(`Uploaded revision ${revision}; the studio shows it once it's read: ${studio.href}`)
    return 0
  }
  io.out(`Uploaded revision ${revision}; waiting for the cloud platform to read it`)
  const deadline = Date.now() + WAIT_MS
  let wait = FIRST_POLL_MS
  while (state.status === 'pending') {
    if (Date.now() >= deadline) {
      throw new CloudError(
        `run ${runId} still wasn't read after ${WAIT_MS / 60_000} minutes; the studio shows it once it is: ${studio.href}`,
      )
    }
    await setTimeout(Math.min(wait, Math.max(0, deadline - Date.now())))
    wait = Math.min(wait * 2, MAX_POLL_MS)
    state = await call<RunState>(
      url,
      { method: 'GET', what: `read how run ${runId} stands`, redirect: 'error' },
      t.auth,
    )
  }
  if (state.status === 'failed') {
    throw new CloudError(
      `the cloud platform couldn't read run ${runId}${state.error ? `: ${state.error}` : ''}`,
    )
  }
  if (state.status !== 'ready') {
    throw new CloudError(`run ${runId} is ${state.status} on the cloud platform`)
  }
  io.out(`Ready: ${studio.href}`)
  return 0
}
