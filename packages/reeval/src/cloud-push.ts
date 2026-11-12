// `reeval cloud push`: one recorded run into the cloud project's studio. It zips the run as
// `history.archive` does (the record and its files, with the manifest hashing each), refuses on
// anything the secret scan finds in them, uploads the zip with the stored sign-in and waits until
// the platform has read it, then prints where the studio shows it. With `--out` it writes the zip
// to a file instead and uploads nothing.
import { existsSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { ArchiveError, writeArchive } from './archive/index.ts'
import { safeZipPath } from './archive/zip.ts'
import type { Flags } from './cli-spec.ts'
import { scanPush } from './cloud-push-scan.ts'
import { CloudError, platformError, printable, request } from './cloud-run.ts'
import { type Target, target } from './cloud-secrets.ts'
import { CommandError, parseLevel, pick, recordedRun } from './commands.ts'
import { UsageError } from './errors.ts'
import {
  leveledArchiveFiles,
  readRunArchiveFiles,
  recordFile,
  scratchDir,
} from './history/files.ts'
import type { ArtifactLevel } from './history/types.ts'
import { RUN_ID } from './ids.ts'
import { plural } from './text.ts'
import type { ResolvedConfig } from './types.ts'
import { formatBytes } from './view/debug.ts'
import { LIVE_FILE, readableLiveProgress } from './view/live.ts'

/** How long the push waits for the platform to read the run before it stops waiting. */
const WAIT_MS = 5 * 60_000
const FIRST_POLL_MS = 500
const MAX_POLL_MS = 5_000
/** The upload's time limit: this, plus a second for every 32 KB the archive holds. */
const UPLOAD_BASE_MS = 2 * 60_000
const UPLOAD_BYTES_PER_SECOND = 32 * 1024
/** How long a single read of the run's state retries before it stops. */
const STATE_MS = 30_000
/** A progress file from another host this old means its run stopped, as the studio reads it. */
const LIVE_STALE_MS = 15_000
const STATUSES = ['pending', 'ready', 'failed'] as const

export type RunState = {
  revision: number
  status: (typeof STATUSES)[number]
  error: string | null
}

export type PushIo = {
  out: (line: string) => void
  /** Warnings: what the secret scan found when `--skip-secret-scan` uploads anyway. */
  err?: (line: string) => void
  /** Progress, with `--json`, when stdout carries the JSON only. */
  note?: (line: string) => void
  env?: NodeJS.ProcessEnv
  /** Where `.reeval/project.json` is looked for: the config's directory, else here. */
  projectDir?: string
}

/** A run's archive files, scanned and safe to zip. */
export type ScannedRun = {
  runId: string
  files: Array<{ path: string; data: Uint8Array }>
  /** The level the archive carries: the run's recorded one, or `--artifacts`. */
  artifacts: ArtifactLevel
}

/** What each level keeps, widest first. */
const LEVELS: readonly ArtifactLevel[] = ['all', 'failures', 'none']

/** Whether `runId`'s `reeval run` is still going: its progress file's process is alive. */
async function stillRunning(root: string, runId: string): Promise<boolean> {
  const text = await readFile(join(root, '.reeval', 'staging', runId, LIVE_FILE), 'utf8').catch(
    () => null,
  )
  if (!text) return false
  let progress: ReturnType<typeof readableLiveProgress> = null
  try {
    progress = readableLiveProgress(JSON.parse(text))
  } catch {}
  if (!progress || progress.runId !== runId) return false
  if (progress.host !== hostname()) {
    return Date.now() - Date.parse(progress.heartbeatAt) < LIVE_STALE_MS
  }
  try {
    process.kill(progress.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const refuseRunning = async (config: ResolvedConfig, runId: string) => {
  if (await stillRunning(config.root, runId)) {
    throw new CommandError(`Run ${runId} is still running: push it once it ends`)
  }
}

/**
 * The run's archive files: as recorded, or with `--artifacts`, at that level, from the recorded
 * run (narrower only) or from a run only in `.reeval/runs`, which stays unrecorded.
 */
async function archiveFiles(
  config: ResolvedConfig,
  flags: Flags,
  ref: string | undefined,
  warn: (line: string) => void,
): Promise<{ runId: string; files: ScannedRun['files'] }> {
  if (flags.artifacts === undefined) {
    const { runId } = await recordedRun(config, ref ?? 'latest')
    return { runId, files: await readRunArchiveFiles(config.history.dir, runId) }
  }
  const level = parseLevel(flags.artifacts, 'all')
  if (ref && RUN_ID.test(ref)) await refuseRunning(config, ref)
  const entry = await pick(config, ref ?? 'latest')
  const { runId } = entry
  await refuseRunning(config, runId)
  // `.reeval/runs` keeps every attempt's files whatever the run was recorded at, so its copy
  // gives any level; only the history folder's is limited to the recorded one.
  const scratch = existsSync(recordFile(scratchDir(config.root), runId))
  const recorded = entry.recorded && !scratch
  let same = false
  const built = await leveledArchiveFiles(
    recorded ? config.history.dir : scratchDir(config.root),
    runId,
    level,
    {
      ...(flags['skip-secret-scan'] && { skipSecretScan: true }),
      check: (run) => {
        if (!recorded) return
        const was = run.artifacts
        if (LEVELS.indexOf(level) < LEVELS.indexOf(was)) {
          throw new CommandError(
            `Run ${runId} was recorded with artifacts ${was}, so --artifacts ${level} can't add what recording left out: push it at ${LEVELS.slice(LEVELS.indexOf(was)).join(' or ')}`,
          )
        }
        same = level === was
      },
    },
  )
  if (same) return { runId, files: await readRunArchiveFiles(config.history.dir, runId) }
  if (built.droppedPatch.length) {
    warn(
      `Left ${runId}'s worktree patch out of the archive: it looks like it holds a secret:\n${built.droppedPatch.map((l) => `  ${l}`).join('\n')}`,
    )
  }
  return { runId, files: built.files }
}

const seg = encodeURIComponent

/** `path` under the cloud project's API, `api/orgs/<org>/projects/<project>/<path>`. */
export const projectUrl = (t: Target, path: string) =>
  new URL(`api/orgs/${seg(t.orgId)}/projects/${seg(t.projectId ?? '')}/${path}`, t.base)

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
    error: typeof b.error === 'string' ? printable(b.error) : null,
  }
}

export const redirected = (what: string) =>
  new CloudError(
    `the cloud platform redirected the request to ${what} elsewhere, and reeval doesn't send your sign-in on: check REEVAL_CLOUD_URL`,
  )

/** `zip` written from `files`, with an archive the writer refuses as a usage error. */
async function writeRunArchive(zip: string, run: ScannedRun): Promise<void> {
  await writeArchive(zip, { contents: 'run', runId: run.runId, files: run.files }).catch(
    (error: unknown) => {
      if (error instanceof ArchiveError) {
        throw new CommandError(`couldn't archive ${run.runId}: ${error.message}`)
      }
      throw error
    },
  )
}

/**
 * The archive of `run`, built in a temporary folder that is removed once it's read, on an
 * error and on Ctrl-C or SIGTERM.
 */
async function archiveBytes(run: ScannedRun): Promise<Buffer<ArrayBuffer>> {
  const tmp = await mkdtemp(join(tmpdir(), 'reeval-push-'))
  const onSignal = (signal: NodeJS.Signals) => {
    rmSync(tmp, { recursive: true, force: true })
    process.exit(signal === 'SIGTERM' ? 143 : 130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const zip = join(tmp, `${run.runId}.zip`)
    await writeRunArchive(zip, run)
    return await readFile(zip)
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * The recorded run `ref` names (default the newest), its files read and scanned: exit 2 on
 * anything the scan finds or can't read, unless `--skip-secret-scan` warns instead.
 */
export async function scannedRun(
  config: ResolvedConfig,
  flags: Flags,
  ref: string | undefined,
  warn: (line: string) => void,
): Promise<ScannedRun> {
  const { runId, files } = await archiveFiles(config, flags, ref, warn)
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
  const record = JSON.parse(Buffer.from(files[0]?.data ?? '{}').toString()) as {
    artifacts?: ArtifactLevel
  }
  return { runId, files, artifacts: record.artifacts ?? 'failures' }
}

const runUrl = (t: Target, runId: string) => projectUrl(t, `studio/runs/${seg(runId)}`)

/** Where the cloud studio shows `runId`. */
export function studioUrl(t: Target, runId: string): URL {
  const studio = new URL('studio', t.base)
  studio.searchParams.set('run', runId)
  return studio
}

/** When reading the run's state stops retrying, and the error it then throws. */
type Deadline = { at: number; timeout: (problem: string) => Error }

/**
 * How the cloud project's copy of `runId` stands, or null when it has none. No answer, a 5xx, a
 * 429 or a refusal the platform marks retryable is asked again, backing off, until `deadline`.
 */
async function readState(t: Target, runId: string, deadline: Deadline): Promise<RunState | null> {
  const what = `read how run ${runId} stands`
  let wait = FIRST_POLL_MS
  let problem = ''
  for (;;) {
    let answer: Awaited<ReturnType<typeof request>> | null = null
    try {
      answer = await request(
        runUrl(t, runId),
        { method: 'GET', what, redirect: 'manual' },
        t.auth.headers,
      )
    } catch (error) {
      if (!(error instanceof CloudError)) throw error
      problem = error.message
    }
    if (answer) {
      if (answer.status >= 300 && answer.status < 400) throw redirected('the status check')
      const retryable =
        (answer.body as { error?: { retryable?: unknown } } | null)?.error?.retryable === true
      if (answer.status >= 500 || answer.status === 429 || (!answer.ok && retryable)) {
        problem = platformError(answer, what, t.auth).message
      } else {
        if (answer.status === 404) return null
        if (!answer.ok) throw platformError(answer, what, t.auth)
        const state = runState(answer.body)
        if (!state) {
          throw new CloudError(
            `the cloud platform answered how run ${runId} stands with something else`,
          )
        }
        return state
      }
    }
    if (Date.now() >= deadline.at) throw deadline.timeout(problem)
    await setTimeout(Math.min(wait, Math.max(0, deadline.at - Date.now())))
    wait = Math.min(wait * 2, MAX_POLL_MS)
  }
}

/** How the cloud project's copy of `runId` stands, or null when it has none. */
export function cloudRunState(t: Target, runId: string): Promise<RunState | null> {
  return readState(t, runId, {
    at: Date.now() + STATE_MS,
    timeout: (problem) => new CloudError(`couldn't read how run ${runId} stands: ${problem}`),
  })
}

/** Waits while the platform reads `runId`, from `state`: its last state, `failed` included. */
export async function waitRead(t: Target, runId: string, state: RunState): Promise<RunState> {
  const studio = studioUrl(t, runId)
  const deadline: Deadline = {
    at: Date.now() + WAIT_MS,
    timeout: (problem) =>
      new CloudError(
        `run ${runId} still wasn't read after ${WAIT_MS / 60_000} minutes${problem ? ` (last: ${problem})` : ''}; the studio shows it once it is: ${studio.href}`,
      ),
  }
  let wait = FIRST_POLL_MS
  let current = state
  while (current.status === 'pending') {
    if (Date.now() >= deadline.at) throw deadline.timeout('')
    await setTimeout(Math.min(wait, Math.max(0, deadline.at - Date.now())))
    wait = Math.min(wait * 2, MAX_POLL_MS)
    const next = await readState(t, runId, deadline)
    if (!next) throw new CloudError(`the cloud platform has no run ${runId} any more`)
    current = next
  }
  return current
}

/**
 * Uploads `run`'s archive to the cloud project and, unless `wait` is false, waits until the
 * platform has read it: its last state, `failed` included.
 */
export async function uploadRun(
  t: Target,
  run: ScannedRun,
  options: { wait: boolean; progress: (line: string) => void },
): Promise<RunState> {
  const { runId } = run
  const body = await archiveBytes(run)
  options.progress(
    `Pushing ${runId}: ${plural(run.files.length, 'file')}, ${formatBytes(body.length)}`,
  )
  const what = `upload run ${runId}`
  const answer = await request(
    runUrl(t, runId),
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
  const state = runState(answer.body)
  if (!state) {
    throw new CloudError(`the cloud platform took run ${runId} without saying how it stands`)
  }
  if (!options.wait) {
    options.progress(
      `Uploaded revision ${state.revision}; the studio shows it once it's read: ${studioUrl(t, runId).href}`,
    )
    return state
  }
  options.progress(`Uploaded revision ${state.revision}; waiting for the cloud platform to read it`)
  return waitRead(t, runId, state)
}

export const readFailed = (runId: string, state: RunState) =>
  new CloudError(
    `the cloud platform couldn't read run ${runId}${state.error ? `: ${state.error}` : ''}`,
  )

/** The cloud project `--org` and `--project` or the link name, with a token to send. */
export async function signedInTarget(flags: Flags, io: PushIo, command: string): Promise<Target> {
  const env = io.env ?? process.env
  const t = await target({ env, projectDir: io.projectDir }, flags, command, 'required')
  if (!t.auth.headers.authorization) {
    throw new UsageError(`reeval ${command} needs you signed in: ${t.auth.refused}`)
  }
  return t
}

const inside = (dir: string, file: string) => {
  const rel = relative(resolve(dir), file)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** `path` with its deepest existing ancestor's symlinks resolved and the rest joined back on. */
async function realAncestor(path: string): Promise<string> {
  const found = await realpath(path).catch(() => null)
  if (found) return found
  const parent = dirname(path)
  return parent === path ? path : join(await realAncestor(parent), basename(path))
}

/** Where `--out` writes: a file, never `-`, a folder, or anywhere reeval keeps runs. */
async function outFile(config: ResolvedConfig, out: string): Promise<string> {
  if (out === '-') {
    throw new UsageError('--out takes a file to write the archive to, not - (stdout)')
  }
  const file = resolve(out)
  // Real paths, so a symlinked folder can't lead into either.
  const real = join(await realAncestor(dirname(file)), basename(file))
  for (const [dir, what] of [
    [config.history.dir, 'the history folder'],
    [join(config.root, '.reeval'), '.reeval/'],
  ] as const) {
    if (inside(await realAncestor(resolve(dir)), real)) {
      throw new UsageError(
        `--out ${out} is inside ${what}, where reeval keeps runs: write the archive somewhere else`,
      )
    }
  }
  const there = await stat(file).catch(() => null)
  if (there?.isDirectory()) {
    throw new UsageError(
      `--out ${out} is a folder: name the file to write, e.g. ${join(out, 'run.zip')}`,
    )
  }
  return file
}

/** Pushes the recorded run `args[0]` names (default the newest) and returns the exit code. */
export async function pushCommand(
  config: ResolvedConfig,
  flags: Flags,
  args: string[],
  io: PushIo,
): Promise<number> {
  const warn = io.err ?? io.out
  const progress = flags.json ? (io.note ?? warn) : io.out
  if (flags.out !== undefined) {
    const extra = (['no-wait', 'org', 'project'] as const).filter((f) => flags[f] !== undefined)
    if (extra.length) {
      throw new UsageError(
        `--out writes the archive to a file and uploads nothing: leave out ${extra.map((f) => `--${f}`).join(', ')}`,
      )
    }
    const file = await outFile(config, flags.out)
    const run = await scannedRun(config, flags, args[0], warn)
    await mkdir(dirname(file), { recursive: true })
    await writeRunArchive(file, run)
    const bytes = (await stat(file)).size
    io.out(
      flags.json
        ? JSON.stringify({ runId: run.runId, out: file, files: run.files.length, bytes })
        : `Wrote ${run.runId} to ${flags.out}: ${plural(run.files.length, 'file')}, ${formatBytes(bytes)}`,
    )
    return 0
  }
  const t = await signedInTarget(flags, io, 'cloud push')
  const run = await scannedRun(config, flags, args[0], warn)
  const state = await uploadRun(t, run, { wait: !flags['no-wait'], progress })
  const studio = studioUrl(t, run.runId).href
  if (flags.json) io.out(JSON.stringify({ runId: run.runId, ...state, studioUrl: studio }))
  if (state.status === 'failed') throw readFailed(run.runId, state)
  if (!flags.json && state.status === 'ready') io.out(`Ready: ${studio}`)
  return 0
}
