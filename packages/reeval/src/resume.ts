// Resume a stopped, interrupted or budget-stopped run: same runId, skip completed attempts,
// restart ones that never wrote a record (or only wrote `aborted`).
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { UsageError } from './errors.ts'
import { scratchDir } from './history/files.ts'
import type { AttemptRecord, RunRecord } from './history/types.ts'
import { RefError } from './history/views.ts'
import { RUN_ID, recordFileName } from './ids.ts'
import { type LiveKept, replace } from './live.ts'
import type { EvalRecord, Outcome } from './types.ts'
import { LIVE_FILE, readableLiveProgress } from './view/live.ts'

/** Other-host / studio: a heartbeat older than this is quiet. A live pid on this host is not. */
const STALE_MS = 15_000

/** Exclusive claim in staging so two CLIs cannot resume the same id through the plan window. */
export const HOLDER_FILE = 'holder'

/** `.reeval/current`: the run id, written when the run starts (after the plan). */
export const currentPath = (root: string) => join(root, '.reeval', 'current')

const stagingOf = (root: string, runId: string) => join(root, '.reeval', 'staging', runId)

export function writeCurrent(root: string, runId: string): void {
  const file = currentPath(root)
  mkdirSync(join(root, '.reeval'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${runId}\n`)
  try {
    replace(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

const stillRunning = (runId: string) =>
  new UsageError(
    `run ${runId} is still running. Wait for it to finish or stop, then reeval run --resume ${runId}.`,
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

const holderLive = (dir: string) => {
  const holder = readHolder(dir)
  return holder ? processAlive(holder.pid, holder.host) : false
}

function acquireHolder(staging: string, runId: string): void {
  const file = join(staging, HOLDER_FILE)
  const body = `${process.pid}\n${hostname()}\n`
  const create = () => writeFileSync(file, body, { flag: 'wx' })
  try {
    create()
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (holderLive(staging)) throw stillRunning(runId)
  try {
    unlinkSync(file)
  } catch {
    throw stillRunning(runId)
  }
  try {
    create()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw stillRunning(runId)
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

const completedFromRecord = (record: RunRecord): string[] =>
  record.evals.flatMap((e) =>
    e.attempts.filter((a) => isCompletedAttempt(a.outcome, a.error)).map((a) => a.key),
  )

function readEvalRecord(path: string): EvalRecord | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as EvalRecord
  } catch {
    return null
  }
}

function stagingRecordComplete(staging: string, key: string): boolean {
  const record = readEvalRecord(join(staging, 'evals', recordFileName(key)))
  if (!record) return false
  return isCompletedAttempt(record.outcome, record.error)
}

/**
 * Attempt keys that already finished in `staging` or in an interrupted/budget scratch, so a
 * resume skips them.
 */
export function completedKeysFor(
  planned: readonly { key: string }[],
  staging: string,
  previous?: RunRecord | null,
): Set<string> {
  const keys = new Set<string>()
  const fromPrevious = new Set(previous ? completedFromRecord(previous) : [])
  for (const { key } of planned) {
    if (stagingRecordComplete(staging, key) || fromPrevious.has(key)) keys.add(key)
  }
  return keys
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
}

function progressLive(
  progress: NonNullable<ReturnType<typeof readableLiveProgress>>,
  now: number,
): boolean {
  // A sleeping laptop goes quiet; the pid is still this process. Do not steal it.
  if (processAlive(progress.pid, progress.host)) return true
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

async function listCandidates(root: string, now = Date.now()): Promise<Candidate[]> {
  const found = new Map<string, Candidate>()
  const stagingRoot = join(root, '.reeval', 'staging')
  const names = await readdir(stagingRoot).catch((): string[] => [])
  for (const runId of names.filter((n) => RUN_ID.test(n))) {
    const dir = join(stagingRoot, runId)
    const info = await stat(dir).catch(() => null)
    if (!info?.isDirectory()) continue
    const text = await readFile(join(dir, LIVE_FILE), 'utf8').catch(() => null)
    const progress = text ? readableLiveProgress(JSON.parse(text) as unknown) : null
    const live = (progress ? progressLive(progress, now) : false) || holderLive(dir)
    const startedAt = progress?.startedAt ?? new Date(info.mtimeMs).toISOString()
    found.set(runId, {
      runId,
      startedAt,
      kind: 'staging',
      live,
      complete: false,
      previous: null,
      previousArtifacts: null,
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

/**
 * `--resume` with no ref (or `latest`): the newest Stopped staging directory, or an
 * `interrupted` / `budget` scratch. A pointer at `.reeval/current` wins when it still names
 * one of those. A live pid (or a holder this process did not steal) is still running: omitted
 * `--resume` names that id instead of "No resumable run". `--resume <ref>` is a run id or
 * unique prefix, not today's assembled `latest` and not a git SHA.
 */
export async function resolveResume(root: string, ref?: string): Promise<ResumeTarget> {
  const candidates = await listCandidates(root)
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
      `No run matches "${ref}". Pass a run id or a unique prefix of one, or leave --resume empty for the newest stopped run.`,
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

/**
 * For a scratch resume: move the assembled record aside so the continuation can write the same
 * id. Staging already in place is left alone.
 */
export async function prepareResume(target: ResumeTarget, root: string): Promise<void> {
  const staging = stagingOf(root, target.runId)
  mkdirSync(join(staging, 'evals'), { recursive: true })
  acquireHolder(staging, target.runId)
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
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
    }
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

export const previousAttempt = (
  previous: RunRecord | null | undefined,
  key: string,
): AttemptRecord | undefined =>
  previous?.evals.flatMap((e) => e.attempts).find((a) => a.key === key)
