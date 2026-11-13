// Resume a stopped, interrupted or budget-stopped run: same runId, skip the attempts that passed
// or failed, restart ones that never wrote a record, only wrote `aborted` or ended in an infra
// error. `--retry-errors` does the same to a finished run, which then reruns only its infra errors.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { UsageError } from './errors.ts'
import { scratchDir } from './history/files.ts'
import type { AttemptRecord, AttemptRetry, RunInvocation, RunRecord } from './history/types.ts'
import { RefError } from './history/views.ts'
import { RUN_ID, recordFileName, relativeFile } from './ids.ts'
import { type LiveKept, replace } from './live.ts'
import type { EvalRecord, Outcome } from './types.ts'
import {
  LIVE_FILE,
  type LiveAttempt,
  readableInvocation,
  readableLiveProgress,
} from './view/live.ts'

/** Other-host / studio: a heartbeat older than this is quiet. A live pid on this host is not. */
const STALE_MS = 15_000

/** Exclusive claim in staging so two CLIs cannot resume the same id through the plan window. */
export const HOLDER_FILE = 'holder'

/** `.reeval/current`: the run id, written when the run starts (after the plan). */
export const currentPath = (root: string) => join(root, '.reeval', 'current')

const stagingOf = (root: string, runId: string) => join(root, '.reeval', 'staging', runId)

/** Where `reeval run --events` with no file writes a run's event stream. */
export const eventsFile = (root: string, runId: string) =>
  join(root, '.reeval', 'events', `${runId}.ndjson`)

/**
 * `reeval clean`: deletes `.reeval/events`' streams of runs with no staging left, but the newest
 * `keep`. Returns the run ids whose streams it deleted.
 */
export async function pruneEvents(root: string, keep: number): Promise<string[]> {
  const dir = join(root, '.reeval', 'events')
  const staged = new Set(await readdir(join(root, '.reeval', 'staging')).catch(() => []))
  const finished = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.endsWith('.ndjson') && RUN_ID.test(f.slice(0, -7)))
    .map((f) => f.slice(0, -7))
    .filter((id) => !staged.has(id))
    .sort()
    .reverse()
    .slice(keep)
  await Promise.all(finished.map((id) => rm(eventsFile(root, id), { force: true })))
  return finished
}

/** Replaced whole, so a reader or a copy of the folder never sees half a file. */
function writeWhole(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  try {
    replace(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

export function writeCurrent(root: string, runId: string): void {
  mkdirSync(join(root, '.reeval'), { recursive: true })
  writeWhole(currentPath(root), `${runId}\n`)
}

type Continue = '--resume' | '--retry-errors'

const stillRunning = (runId: string, flag: Continue = '--resume') =>
  new UsageError(
    flag === '--resume'
      ? `run ${runId} is still running. Wait for it to finish or stop, then reeval run --resume ${runId}.`
      : `run ${runId} is still running. Wait for it to finish, then reeval run --retry-errors ${runId}; if it stops before then, reeval run --resume ${runId} finishes it and retries its infra errors.`,
  )

/** Same host only: `kill(pid, 0)`. Another host cannot be probed. */
export function processAlive(pid: number, host: string): boolean {
  if (host !== hostname()) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * The signal `reeval attach` cancels a run with: `reeval run` takes it as a first Ctrl-C, and
 * ignores it once the run is canceling or finishing.
 */
export const CANCEL_SIGNAL = 'SIGUSR2'

/**
 * Whether `reeval attach` may cancel the run `header` names: its live.json is that same
 * process, alive on this host, still running attempts and beating. A stream's pid alone could be
 * another process by now, or a run already canceling, which a signal would quit without a record.
 */
export function cancelable(
  root: string,
  header: { runId: string; pid: number; host: string },
  options: { now?: number; alive?: (pid: number, host: string) => boolean } = {},
): boolean {
  if (process.platform === 'win32' || header.host !== hostname()) return false
  if (!(options.alive ?? processAlive)(header.pid, header.host)) return false
  let progress: ReturnType<typeof readableLiveProgress>
  try {
    progress = readableLiveProgress(
      JSON.parse(readFileSync(join(stagingOf(root, header.runId), LIVE_FILE), 'utf8')),
    )
  } catch {
    return false
  }
  if (progress?.phase !== 'running') return false
  const now = options.now ?? Date.now()
  return (
    progress.runId === header.runId &&
    progress.pid === header.pid &&
    progress.host === header.host &&
    now - Date.parse(progress.heartbeatAt) <= STALE_MS
  )
}

function readHolder(dir: string): { pid: number; host: string } | null {
  try {
    const [pidLine, hostLine] = readFileSync(join(dir, HOLDER_FILE), 'utf8').split('\n')
    const pid = Number(pidLine)
    if (!Number.isInteger(pid) || pid <= 0 || !hostLine) return null
    return { pid, host: hostLine }
  } catch {
    return null
  }
}

/**
 * Another process than this one is alive at `pid` on this host. A run folder copied to a new
 * machine or container can name the pid this process now has, and that isn't a run still going.
 */
const otherProcessAlive = (pid: number, host: string) =>
  !(pid === process.pid && host === hostname()) && processAlive(pid, host)

const holderLive = (dir: string) => {
  const holder = readHolder(dir)
  return holder ? otherProcessAlive(holder.pid, holder.host) : false
}

/** This process holds the run's staging. */
const holdsStaging = (staging: string) => {
  const holder = readHolder(staging)
  return holder?.pid === process.pid && holder.host === hostname()
}

function acquireHolder(staging: string, runId: string, flag?: Continue): void {
  const file = join(staging, HOLDER_FILE)
  const body = `${process.pid}\n${hostname()}\n`
  const create = () => writeFileSync(file, body, { flag: 'wx' })
  try {
    create()
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (holderLive(staging)) throw stillRunning(runId, flag)
  try {
    unlinkSync(file)
  } catch {
    throw stillRunning(runId, flag)
  }
  try {
    create()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw stillRunning(runId, flag)
    throw error
  }
}

export function readCurrent(root: string): string | null {
  try {
    const id = readFileSync(currentPath(root), 'utf8').trim()
    return RUN_ID.test(id) ? id : null
  } catch {
    return null
  }
}

/** Finished with a real outcome: not queued, not skipped, not a cancel abort. */
export function isCompletedAttempt(
  outcome: Outcome,
  error: { kind: string } | null | undefined,
): boolean {
  if (outcome === 'skipped') return false
  if (error?.kind === 'aborted') return false
  return outcome === 'pass' || outcome === 'fail' || outcome === 'infra_error'
}

/** Completed with a result a resume keeps, a pass or a fail; an infra error runs again. */
export function isKeptAttempt(
  outcome: Outcome,
  error: { kind: string } | null | undefined,
): boolean {
  return outcome !== 'infra_error' && isCompletedAttempt(outcome, error)
}

const keptFromRecord = (record: RunRecord): string[] =>
  record.evals.flatMap((e) =>
    e.attempts.filter((a) => isKeptAttempt(a.outcome, a.error)).map((a) => a.key),
  )

function readEvalRecord(path: string): EvalRecord | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as EvalRecord
  } catch {
    return null
  }
}

function stagingRecordComplete(
  staging: string,
  key: string,
  done: typeof isCompletedAttempt = isCompletedAttempt,
): boolean {
  const record = readEvalRecord(join(staging, 'evals', recordFileName(key)))
  if (!record) return false
  return done(record.outcome, record.error)
}

/**
 * Attempt keys that already passed or failed in `staging` or in the previous record, so a
 * resume skips them and runs the rest, infra errors included.
 */
export function completedKeysFor(
  planned: readonly { key: string }[],
  staging: string,
  previous?: RunRecord | null,
): Set<string> {
  const keys = new Set<string>()
  const fromPrevious = new Set(previous ? keptFromRecord(previous) : [])
  for (const { key } of planned) {
    if (stagingRecordComplete(staging, key, isKeptAttempt) || fromPrevious.has(key)) keys.add(key)
  }
  return keys
}

/** In staging: each attempt's earlier infra errors, by key, kept as the attempts run again. */
export const RETRIES_FILE = 'retries.json'

export function readRetries(staging: string): Map<string, AttemptRetry[]> {
  try {
    const parsed = JSON.parse(readFileSync(join(staging, RETRIES_FILE), 'utf8')) as Record<
      string,
      AttemptRetry[]
    >
    return new Map(Object.entries(parsed))
  } catch {
    return new Map()
  }
}

/**
 * The planned attempts that ended in an infra error, in staging or the previous record, and so
 * run again; and each one's earlier errors, which `retries.json` keeps once `write` is set, so
 * the record still has them after the worker replaces the attempt's staged record.
 */
export function noteRetries(
  planned: readonly { key: string }[],
  staging: string,
  previous: RunRecord | null | undefined,
  write: boolean,
): { errored: Set<string>; retries: Map<string, AttemptRetry[]> } {
  const retries = readRetries(staging)
  const errored = new Set<string>()
  const add = (key: string, retry: AttemptRetry) => {
    const list = retries.get(key) ?? []
    const same = (r: AttemptRetry) => r.at === retry.at && r.error.message === retry.error.message
    if (!list.some(same)) list.push(retry)
    retries.set(key, list)
  }
  for (const { key } of planned) {
    const was = previousAttempt(previous, key)
    if (was?.retries?.length && !retries.has(key)) retries.set(key, [...was.retries])
    const staged = readEvalRecord(join(staging, 'evals', recordFileName(key)))
    const last = staged ?? (was ? { outcome: was.outcome, error: was.error } : null)
    if (last?.outcome !== 'infra_error' || !last.error || last.error.kind === 'aborted') continue
    errored.add(key)
    add(key, { error: last.error, at: staged?.startedAt ?? was?.startedAt ?? null })
  }
  if (write && retries.size) {
    mkdirSync(staging, { recursive: true })
    writeWhole(join(staging, RETRIES_FILE), `${JSON.stringify(Object.fromEntries(retries))}\n`)
  }
  return { errored, retries }
}

/** An attempt the run planned that a filtered resume leaves out of its plan. */
export type LeftOut = Pick<LiveAttempt, 'key' | 'evalId' | 'name' | 'file' | 'cell' | 'n'> & {
  /** Finished earlier in the run; else it never started or didn't finish, and stays not run. */
  done: boolean
}

/**
 * The attempts the run planned, from the previous record and the progress file a quit left,
 * that this resume's plan leaves out. The record keeps them, so the run stays incomplete until
 * a resume runs the ones that aren't done. A todo or a declared skip, in the previous record or
 * `declared` (the ids this resume collected as `.skip` or `.todo`), never runs, so it's done.
 */
export function leftOutAttempts(
  planned: readonly { key: string }[],
  staging: string,
  previous: RunRecord | null | undefined,
  live: readonly LiveAttempt[],
  declared: ReadonlySet<string> = new Set(),
): LeftOut[] {
  const now = new Set(planned.map((p) => p.key))
  const found = new Map<string, LeftOut>()
  const add = (a: Omit<LeftOut, 'done'>, finished: boolean) => {
    if (now.has(a.key) || found.has(a.key)) return
    const done = finished || declared.has(a.evalId) || stagingRecordComplete(staging, a.key)
    found.set(a.key, { ...a, done })
  }
  for (const e of previous?.evals ?? []) {
    for (const a of e.attempts) {
      const at = { key: a.key, evalId: e.id, name: e.name, file: e.file, cell: a.cell, n: a.n }
      add(at, e.todo || e.skip === true || isCompletedAttempt(a.outcome, a.error))
    }
  }
  for (const a of live) add(a, false)
  return [...found.values()]
}

/** The attempts in a stopped run's progress file, or none. */
export async function liveAttempts(staging: string): Promise<LiveAttempt[]> {
  const text = await readFile(join(staging, LIVE_FILE), 'utf8').catch(() => null)
  try {
    return (text ? readableLiveProgress(JSON.parse(text) as unknown)?.attempts : null) ?? []
  } catch {
    return []
  }
}

/**
 * How each completed attempt finished, for the progress file: from the previous assemble when it
 * has the attempt (as the record keeps it), else from its staged record, which has no duration.
 */
export function keptAttempts(
  completed: Iterable<string>,
  staging: string,
  previous?: RunRecord | null,
): Map<string, LiveKept> {
  const kept = new Map<string, LiveKept>()
  for (const key of completed) {
    const was = previousAttempt(previous, key)
    if (was && was.outcome !== 'skipped' && isCompletedAttempt(was.outcome, was.error)) {
      kept.set(key, { outcome: was.outcome, startedAt: was.startedAt, durationMs: was.durationMs })
      continue
    }
    const record = readEvalRecord(join(staging, 'evals', recordFileName(key)))
    if (!record || !isCompletedAttempt(record.outcome, record.error)) continue
    kept.set(key, {
      outcome: record.outcome,
      startedAt: record.startedAt ?? null,
      durationMs: null,
    })
  }
  return kept
}

export type ResumeTarget = {
  runId: string
  startedAt: Date
  kind: 'staging' | 'scratch'
  previous: RunRecord | null
  previousArtifacts: string | null
}

type Candidate = {
  runId: string
  startedAt: string
  kind: 'staging' | 'scratch'
  live: boolean
  complete: boolean
  previous: RunRecord | null
  previousArtifacts: string | null
  /** The scratch record, complete or not. */
  record: RunRecord | null
  artifacts: string | null
}

function progressLive(
  progress: NonNullable<ReturnType<typeof readableLiveProgress>>,
  now: number,
): boolean {
  // A sleeping laptop goes quiet; the pid is still that run's process. Do not steal it.
  if (otherProcessAlive(progress.pid, progress.host)) return true
  const quiet = now - Date.parse(progress.heartbeatAt) > STALE_MS
  if (quiet) return false
  return progress.host !== hostname()
}

async function readScratch(root: string, runId: string): Promise<RunRecord | null> {
  try {
    const text = await readFile(join(scratchDir(root), `${runId}.json`), 'utf8')
    const record = JSON.parse(text) as RunRecord
    return record.kind === 'reeval-run' && record.runId === runId ? record : null
  } catch {
    return null
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function readProgress(dir: string) {
  const text = await readFile(join(dir, LIVE_FILE), 'utf8').catch(() => null)
  return text ? readableLiveProgress(parseJson(text)) : null
}

/**
 * `movedIn`: the run's state was moved here (`reeval run --bundle --resume`), so a `live.json`
 * from another host is that host's past run, not one still going. A holder on another host is
 * never live, since its pid can't be probed.
 */
const stagingLive = (
  dir: string,
  progress: Awaited<ReturnType<typeof readProgress>>,
  now: number,
  movedIn = false,
) =>
  (progress && !(movedIn && progress.host !== hostname()) ? progressLive(progress, now) : false) ||
  holderLive(dir)

/**
 * `reeval run --bundle --resume`: a process on this host still runs from `staging`, by its holder
 * or its `live.json`, so moving the staging away would take the work from under it. Another
 * host's `live.json` is that host's, as once the staging is moved in.
 */
export function stagingInUse(staging: string, now = Date.now()): boolean {
  let text: string | null = null
  try {
    text = readFileSync(join(staging, LIVE_FILE), 'utf8')
  } catch {}
  return stagingLive(staging, text ? readableLiveProgress(parseJson(text)) : null, now, true)
}

/** Options of `resolveResume`. */
export type ResolveOptions = {
  /** The run's state was moved into this project, which owns it now: `--bundle --resume`. */
  movedIn?: boolean
}

async function listCandidates(
  root: string,
  now = Date.now(),
  { movedIn = false }: ResolveOptions = {},
): Promise<Candidate[]> {
  const found = new Map<string, Candidate>()
  const stagingRoot = join(root, '.reeval', 'staging')
  const names = await readdir(stagingRoot).catch((): string[] => [])
  for (const runId of names.filter((n) => RUN_ID.test(n))) {
    const dir = join(stagingRoot, runId)
    const info = await stat(dir).catch(() => null)
    if (!info?.isDirectory()) continue
    const progress = await readProgress(dir)
    const live = stagingLive(dir, progress, now, movedIn)
    const startedAt = progress?.startedAt ?? new Date(info.mtimeMs).toISOString()
    found.set(runId, {
      runId,
      startedAt,
      kind: 'staging',
      live,
      complete: false,
      previous: null,
      previousArtifacts: null,
      record: null,
      artifacts: null,
    })
  }
  const scratch = scratchDir(root)
  const records = (await readdir(scratch).catch((): string[] => [])).filter(
    (n) => n.endsWith('.json') && RUN_ID.test(n.slice(0, -5)),
  )
  for (const name of records) {
    const runId = name.slice(0, -5)
    const record = await readScratch(root, runId)
    if (!record) continue
    const artifacts = join(scratch, runId)
    const previousArtifacts = existsSync(artifacts) ? artifacts : null
    const complete = record.status === 'complete'
    const existing = found.get(runId)
    if (existing) {
      // Staging is the live work; the scratch is a leftover assemble.
      existing.previous = record
      existing.previousArtifacts = previousArtifacts
      existing.complete = complete
      existing.record = record
      existing.artifacts = previousArtifacts
      continue
    }
    found.set(runId, {
      runId,
      startedAt: record.startedAt,
      kind: 'scratch',
      live: false,
      complete,
      previous: complete ? null : record,
      previousArtifacts: complete ? null : previousArtifacts,
      record,
      artifacts: previousArtifacts,
    })
  }
  return [...found.values()].sort((a, b) => (a.runId < b.runId ? -1 : 1))
}

const resumable = (c: Candidate) =>
  !c.live &&
  !c.complete &&
  (c.kind === 'staging' || c.previous?.status === 'interrupted' || c.previous?.status === 'budget')

function toTarget(c: Candidate): ResumeTarget {
  return {
    runId: c.runId,
    startedAt: new Date(c.startedAt),
    kind: c.kind,
    previous: c.previous,
    previousArtifacts: c.previousArtifacts,
  }
}

function matchRef(candidates: Candidate[], ref: string): Candidate | undefined {
  const exact = candidates.find((c) => c.runId === ref)
  if (exact) return exact
  const byId = candidates.filter((c) => c.runId.startsWith(ref))
  if (byId.length === 1) return byId[0]
  if (byId.length > 1) {
    throw new RefError(`"${ref}" matches ${byId.length} runs: use more of the id`)
  }
  return undefined
}

/** Staging untouched this long is a leftover the sweep at the start of a run looks at. */
const STALE_STAGING_MS = 24 * 60 * 60 * 1000

/**
 * Staging a resume keeps something from: a finished attempt, or the record a resume or retry
 * moved aside.
 */
async function holdsWork(dir: string): Promise<boolean> {
  if (existsSync(join(dir, 'previous.json'))) return true
  const names = await readdir(join(dir, 'evals')).catch((): string[] => [])
  return names.some((name) => {
    const record = readEvalRecord(join(dir, 'evals', name))
    return !!record && isCompletedAttempt(record.outcome, record.error)
  })
}

/**
 * Removes staging untouched for a day that a resume would keep nothing from (a run that finished
 * assembling, one stopped before any attempt finished, or a stray entry), and returns the ids of
 * the stale runs it keeps because `--resume` still can. A running run's staging, and `keep`'s,
 * are left alone.
 */
export async function sweepStaging(
  root: string,
  keep?: string,
  now = Date.now(),
): Promise<string[]> {
  const stagingRoot = join(root, '.reeval', 'staging')
  const names = await readdir(stagingRoot).catch((): string[] => [])
  const resumableIds: string[] = []
  for (const name of names.sort()) {
    if (name === keep) continue
    const dir = join(stagingRoot, name)
    const info = await stat(dir).catch(() => null)
    if (!info || now - info.mtimeMs <= STALE_STAGING_MS) continue
    const run = RUN_ID.test(name) && info.isDirectory()
    if (run && stagingLive(dir, await readProgress(dir), now)) continue
    const open = run && (await readScratch(root, name))?.status !== 'complete'
    if (open && (await holdsWork(dir))) resumableIds.push(name)
    else await rm(dir, { recursive: true, force: true })
  }
  return resumableIds
}

/**
 * `reeval clean --staging`: removes every stopped run's staging and returns their ids. A record
 * a resume or retry moved aside into it goes back to `.reeval/runs` first, since it can be the
 * run's only copy.
 */
export async function removeStoppedStaging(root: string, now = Date.now()): Promise<string[]> {
  const stagingRoot = join(root, '.reeval', 'staging')
  const names = await readdir(stagingRoot).catch((): string[] => [])
  const removed: string[] = []
  for (const name of names.sort()) {
    const dir = join(stagingRoot, name)
    if (stagingLive(dir, await readProgress(dir), now)) continue
    if (RUN_ID.test(name)) putBackAside(root, name)
    await rm(dir, { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

/**
 * `--resume` with no ref (or `latest`): the newest Stopped staging directory, or an
 * `interrupted` / `budget` scratch. A pointer at `.reeval/current` wins when it still names
 * one of those. A live pid (or a holder this process did not steal) is still running: omitted
 * `--resume` names that id instead of "No resumable run". `--resume <ref>` is a run id or
 * unique prefix, not today's assembled `latest` and not a git SHA.
 */
export async function resolveResume(
  root: string,
  ref?: string,
  options: ResolveOptions = {},
): Promise<ResumeTarget> {
  const candidates = await listCandidates(root, Date.now(), options)
  const open = candidates.filter(resumable)
  const omitted = ref === undefined || ref === '' || ref === 'latest'
  if (omitted) {
    const pointer = readCurrent(root)
    const pointed = pointer ? open.find((c) => c.runId === pointer) : undefined
    const pick = pointed ?? open.at(-1)
    if (!pick) {
      const liveOnes = candidates.filter((c) => c.live)
      const pointedLive = pointer ? liveOnes.find((c) => c.runId === pointer) : undefined
      const livePick = pointedLive ?? liveOnes.at(-1)
      if (livePick) throw stillRunning(livePick.runId)
      throw new UsageError(
        'No resumable run. A stopped staging directory, or an interrupted or budget-stopped scratch record, can be resumed.',
      )
    }
    return toTarget(pick)
  }
  const back = /^latest~(\d+)$/.exec(ref)
  if (back) {
    const entry = open[open.length - 1 - Number(back[1])]
    if (!entry)
      throw new RefError(
        `There ${open.length === 1 ? 'is only 1 resumable run' : `are only ${open.length} resumable runs`}, so ${ref} names none. reeval run --resume resumes the newest.`,
      )
    return toTarget(entry)
  }
  const found = matchRef(candidates, ref)
  if (!found) {
    throw new RefError(
      options.movedIn
        ? `No run matches "${ref}" in ${join(root, '.reeval')}.`
        : `No run matches "${ref}". Pass a run id or a unique prefix of one, or leave --resume empty for the newest stopped run.`,
    )
  }
  if (found.live) throw stillRunning(found.runId)
  if (found.complete || !resumable(found)) {
    throw new UsageError(
      `run ${found.runId} is complete and cannot be resumed. reeval run starts a new run.`,
    )
  }
  return toTarget(found)
}

const finished = (c: Candidate) => !c.live && c.complete && c.record !== null

/**
 * `--retry-errors` with no ref (or `latest`): the newest finished run, whose scratch record is
 * `complete`; `latest~N` counts back over those. A ref is a run id or unique prefix, as for
 * `--resume`. A run that didn't finish is left to `--resume`, which retries its infra errors too.
 */
export async function resolveRetry(root: string, ref?: string): Promise<ResumeTarget> {
  const candidates = await listCandidates(root)
  const done = candidates.filter(finished)
  const target = (c: Candidate): ResumeTarget => ({
    runId: c.runId,
    startedAt: new Date(c.startedAt),
    kind: c.kind,
    previous: c.record,
    previousArtifacts: c.artifacts,
  })
  if (ref === undefined || ref === '' || ref === 'latest') {
    const pick = done.at(-1)
    const running = candidates.filter((c) => c.live && (!pick || c.runId > pick.runId)).at(-1)
    if (running) {
      throw new UsageError(
        `run ${running.runId} is still running, so --retry-errors can't tell which run to retry. Wait for it to finish, or pass the run id.`,
      )
    }
    if (!pick) {
      throw new UsageError(
        'No finished run to retry. --retry-errors re-runs the infra errors of a complete run in .reeval/runs; reeval run --resume continues one that stopped.',
      )
    }
    return target(pick)
  }
  const back = /^latest~(\d+)$/.exec(ref)
  if (back) {
    const entry = done[done.length - 1 - Number(back[1])]
    if (!entry)
      throw new RefError(
        `There ${done.length === 1 ? 'is only 1 finished run' : `are only ${done.length} finished runs`}, so ${ref} names none. reeval run --retry-errors retries the newest.`,
      )
    return target(entry)
  }
  const found = matchRef(candidates, ref)
  if (!found) {
    throw new RefError(
      `No run matches "${ref}". Pass a run id or a unique prefix of one, or leave --retry-errors empty for the newest finished run.`,
    )
  }
  if (found.live) throw stillRunning(found.runId, '--retry-errors')
  if (!finished(found)) {
    throw new UsageError(
      `run ${found.runId} didn't finish. reeval run --resume ${found.runId} runs the rest and retries its infra errors.`,
    )
  }
  return target(found)
}

/** The run `reeval attach` follows, and its event stream file. */
export type AttachTarget = { runId: string; file: string; live: boolean }

/**
 * `reeval attach` with no ref (or `latest`): the run in progress, from staging as `--resume` finds
 * runs, the one `.reeval/current` names when it's running, else the newest running one. A ref is a
 * run id or unique prefix of a run in staging or with a stream in `.reeval/events`. Its stream is
 * the file its live.json names, else its `.reeval/events/<run>.ndjson`.
 */
export async function resolveAttach(root: string, ref?: string): Promise<AttachTarget> {
  const candidates = await listCandidates(root)
  let runId: string
  if (ref === undefined || ref === '' || ref === 'latest') {
    const running = candidates.filter((c) => c.live)
    const pointer = readCurrent(root)
    const pick = running.find((c) => c.runId === pointer) ?? running.at(-1)
    if (!pick) {
      throw new UsageError(
        'No run in progress to attach to. reeval attach <run> follows a run by id, or <file|url> a stream; reeval run --events writes one.',
      )
    }
    runId = pick.runId
  } else {
    const streams = (await readdir(join(root, '.reeval', 'events')).catch((): string[] => []))
      .filter((n) => n.endsWith('.ndjson'))
      .map((n) => n.slice(0, -'.ndjson'.length))
    const ids = [...new Set([...candidates.map((c) => c.runId), ...streams])]
      .filter((id) => RUN_ID.test(id))
      .sort()
    const byId = ids.includes(ref) ? [ref] : ids.filter((id) => id.startsWith(ref))
    if (byId.length > 1)
      throw new RefError(`"${ref}" matches ${byId.length} runs: use more of the id`)
    const [only] = byId
    if (!only) {
      throw new RefError(
        `No run, stream file or URL matches "${ref}". Pass a run id or a unique prefix of one, a stream file, or leave it out for the run in progress.`,
      )
    }
    runId = only
  }
  const live = candidates.find((c) => c.runId === runId)?.live ?? false
  const named = (await readProgress(stagingOf(root, runId)))?.events
  const file = named ? resolve(root, named) : eventsFile(root, runId)
  if (!existsSync(file)) {
    throw new UsageError(
      live
        ? `run ${runId} is running without --events, so it has no event stream to attach to.`
        : `run ${runId} has no event stream: reeval run --events writes one.`,
    )
  }
  return { runId, file, live }
}

/** The attempts of a run that ended in an infra error (not a cancel). */
export const erroredAttempts = (record: Pick<RunRecord, 'evals'>): AttemptRecord[] =>
  record.evals.flatMap((e) =>
    e.attempts.filter((a) => a.outcome === 'infra_error' && a.error?.kind !== 'aborted'),
  )

/**
 * For a scratch resume: move the assembled record aside so the continuation can write the same
 * id. Staging already in place is left alone.
 */
export async function prepareResume(
  target: ResumeTarget,
  root: string,
  { held = false }: { held?: boolean } = {},
): Promise<void> {
  const staging = stagingOf(root, target.runId)
  mkdirSync(join(staging, 'evals'), { recursive: true })
  // `held`: a retry holds its staging from before it collects ({@link holdRetry}).
  if (!(held && holdsStaging(staging))) acquireHolder(staging, target.runId)
  if (!target.previous) return
  const scratch = scratchDir(root)
  const recordPath = join(scratch, `${target.runId}.json`)
  const aside = join(staging, 'previous.json')
  if (existsSync(recordPath) && !existsSync(aside)) renameSync(recordPath, aside)
  if (target.previousArtifacts && existsSync(target.previousArtifacts)) {
    const dest = join(staging, 'previous-artifacts')
    if (!existsSync(dest)) renameSync(target.previousArtifacts, dest)
  }
  // So assemble can merge them if a later crash leaves only staging.
  for (const e of target.previous.evals) {
    for (const a of e.attempts) {
      if (!isCompletedAttempt(a.outcome, a.error)) continue
      const path = join(staging, 'evals', recordFileName(a.key))
      if (existsSync(path)) continue
      const record: EvalRecord = {
        outcome: a.outcome === 'skipped' ? 'fail' : a.outcome,
        error: a.error,
        startedAt: a.startedAt ?? undefined,
        turns: [],
        diff: null,
        checks: [],
        judgements: [],
        timings: { setupMs: 0, agentMs: 0, diffMs: 0, checksMs: 0, judgeMs: 0 },
      }
      writeWhole(path, `${JSON.stringify(record, null, 2)}\n`)
    }
  }
}

/**
 * Holds a retry's run before it collects, so a second retry or resume of it stops as still
 * running rather than racing this one to {@link prepareResume}.
 */
export function holdRetry(target: ResumeTarget, root: string): void {
  const staging = stagingOf(root, target.runId)
  mkdirSync(join(staging, 'evals'), { recursive: true })
  acquireHolder(staging, target.runId, '--retry-errors')
}

/**
 * A run a `--retry-errors` stopped during, which a `--resume` finishes as that retry. Its
 * interrupted record lists the retry in `retriedAt`, or a kill stopped the retry before it
 * assembled one: then staging still has the finished record the retry moved aside (only a retry
 * moves a `complete` one), and `began` is when the retry planned, from its `retries.json` (else
 * now), which that record has no entry for. Null for any other run.
 */
export async function stoppedRetry(
  root: string,
  target: ResumeTarget,
): Promise<{ began: Date | null } | null> {
  if (target.previous?.retriedAt?.length) return { began: null }
  const staging = stagingOf(root, target.runId)
  const { record } = await loadPrevious(staging)
  if (record?.status === 'complete') {
    const planned = await stat(join(staging, RETRIES_FILE)).catch(() => null)
    return { began: planned?.mtime ?? new Date() }
  }
  return record?.retriedAt?.length ? { began: null } : null
}

/**
 * Undoes a retry's {@link prepareResume} when it stops before the engine runs: the finished
 * record and its artifacts go back to `.reeval/runs`, and its staging is removed.
 */
export async function restoreRetry(root: string, runId: string): Promise<void> {
  const staging = stagingOf(root, runId)
  // Another process's retry of the run holds its staging: leave that retry alone.
  if (!holdsStaging(staging)) return
  putBackAside(root, runId)
  if (existsSync(join(scratchDir(root), `${runId}.json`))) {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Moves the record and artifacts {@link prepareResume} set aside in staging back to `.reeval/runs`. */
function putBackAside(root: string, runId: string): void {
  const staging = stagingOf(root, runId)
  const scratch = scratchDir(root)
  const aside = join(staging, 'previous.json')
  const recordPath = join(scratch, `${runId}.json`)
  if (existsSync(aside) && !existsSync(recordPath)) {
    mkdirSync(scratch, { recursive: true })
    renameSync(aside, recordPath)
  }
  const artifacts = join(staging, 'previous-artifacts')
  if (existsSync(artifacts) && !existsSync(join(scratch, runId))) {
    renameSync(artifacts, join(scratch, runId))
  }
}

export async function loadPrevious(staging: string): Promise<{
  record: RunRecord | null
  artifacts: string | null
}> {
  const file = join(staging, 'previous.json')
  const artifacts = join(staging, 'previous-artifacts')
  try {
    const record = JSON.parse(await readFile(file, 'utf8')) as RunRecord
    return {
      record: record.kind === 'reeval-run' ? record : null,
      artifacts: existsSync(artifacts) ? artifacts : null,
    }
  } catch {
    return { record: null, artifacts: existsSync(artifacts) ? artifacts : null }
  }
}

/**
 * How the run was first started: from the progress file a quit left, else the record a resume
 * moved aside, else the interrupted or budget-stopped record. Null for a run an older reeval
 * started.
 */
export async function savedInvocation(
  root: string,
  target: ResumeTarget,
): Promise<RunInvocation | null> {
  const staging = stagingOf(root, target.runId)
  const text = await readFile(join(staging, LIVE_FILE), 'utf8').catch(() => null)
  try {
    const live = text ? readableLiveProgress(JSON.parse(text) as unknown) : null
    if (live?.invocation) return live.invocation
  } catch {}
  const { record } = await loadPrevious(staging)
  return readableInvocation((record ?? target.previous)?.invocation) ?? null
}

/**
 * Filters as a run saves them: a part naming a path on disk (from `cwd`, as the engine reads it),
 * or any absolute part, becomes that path relative to `root` in posix form, `.` for the root
 * itself and `../…` outside it, so no host path is written and a resume resolves it from the
 * root. An absolute part matches files by the start of their path, which the relative form
 * keeps. Other parts are names.
 */
export function savedFilters(root: string, filters: readonly string[], cwd = process.cwd()) {
  return filters.map((f) => {
    const path = resolve(cwd, f)
    if (!isAbsolute(f) && !existsSync(path)) return f
    const slash = /[\\/]$/.test(f) ? '/' : ''
    return (relativeFile(root, path) || '.') + slash
  })
}

/** The `reeval run` flags and filters that shape a run's plan, as the command line gives them. */
export type RunSettings = {
  runs?: string
  profile?: string
  concurrency?: string
  tag?: string[]
  trait?: string[]
  filters: string[]
}

/**
 * The settings a resume plans with: each one left out is the run's saved one. `--runs` or a
 * profile other than the run's is refused, since it plans other attempts than the ones kept;
 * filters, `--tag` and `--trait` replace the run's for this resume, and `--concurrency` wins with a note.
 * A `--runs` that isn't a count is left for the usual check to refuse. Saved path filters are
 * resolved from `root`, so the resume picks the same files from any directory.
 */
export function resumeSettings(
  runId: string,
  saved: RunInvocation,
  given: RunSettings,
  {
    root,
    env = process.env,
    flag: continued = '--resume',
  }: { root: string; env?: NodeJS.ProcessEnv; flag?: '--resume' | '--retry-errors' },
): { settings: RunSettings; notes: string[] } {
  const refuse = (started: string, flag: string) =>
    new UsageError(
      `run ${runId} was started ${started}, and ${continued} finishes the attempts it planned. Leave ${flag} out, or start a new run without ${continued}.`,
    )
  const runs = Number(given.runs)
  const count = Number.isInteger(runs) && runs >= 1
  if (given.runs !== undefined && count && runs !== saved.runs) {
    throw refuse(
      saved.runs === undefined ? 'without --runs' : `with --runs ${saved.runs}`,
      '--runs',
    )
  }
  const profile = given.profile ?? (env.REEVAL_PROFILE || undefined)
  if (profile !== undefined && profile !== saved.profile) {
    throw refuse(
      saved.profile === undefined ? 'without a profile' : `with profile ${saved.profile}`,
      '--profile and REEVAL_PROFILE',
    )
  }
  const notes: string[] = []
  const concurrency = given.concurrency ?? (env.REEVAL_CONCURRENCY || undefined)
  if (concurrency !== undefined && saved.concurrency !== undefined) {
    if (Number(concurrency) !== saved.concurrency) {
      notes.push(
        `concurrency ${concurrency} replaces the ${saved.concurrency} run ${runId} was started with`,
      )
    }
  }
  const settings: RunSettings = {
    ...given,
    filters: given.filters.length
      ? given.filters
      : saved.filters.map((f) => (existsSync(resolve(root, f)) ? resolve(root, f) : f)),
  }
  if (given.runs === undefined && saved.runs !== undefined) settings.runs = String(saved.runs)
  if (profile === undefined && saved.profile !== undefined) settings.profile = saved.profile
  if (concurrency === undefined && saved.concurrency !== undefined) {
    settings.concurrency = String(saved.concurrency)
  }
  if (!given.tag?.length && saved.tags.length) settings.tag = saved.tags
  if (!given.trait?.length && saved.traits?.length) settings.trait = saved.traits
  return { settings, notes }
}

export const previousAttempt = (
  previous: RunRecord | null | undefined,
  key: string,
): AttemptRecord | undefined =>
  previous?.evals.flatMap((e) => e.attempts).find((a) => a.key === key)
