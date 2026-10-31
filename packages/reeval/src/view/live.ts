// A run in progress, as the studio shows it. Browser-safe. The running `reeval run` keeps one
// `.reeval/staging/<runId>/live.json` (a `LiveProgress`) and replaces it whole on every change; it's
// never part of a run record, and it goes when the record lands.

import type { RunInvocation } from '../history/types.ts'
import { isOneOf } from '../object.ts'
import { fillDefaults } from './record.ts'

/** The progress file's name inside the run's staging directory. */
export const LIVE_FILE = 'live.json'
export const LIVE_SCHEMA_VERSION = 1

/** Where an attempt is: waiting, running, or finished with its outcome. */
export type LiveStatus = 'queued' | 'running' | 'pass' | 'fail' | 'infra_error' | 'skipped'

export type LiveAttempt = {
  /** The attempt key, `<eval id> # <cell key>#<n>`, as in the record. */
  key: string
  evalId: string
  name: string
  file: string
  /** The cell key, e.g. `fake/default/fake`. */
  cell: string
  n: number
  status: LiveStatus
  startedAt: string | null
  durationMs: number | null
}

/** Attempts finished, and of those how many passed, failed or errored; and how many are running. */
export type LiveCounts = {
  done: number
  passed: number
  failed: number
  errored: number
  skipped: number
  running: number
}

/** What the run is doing: running attempts, canceling them, or assembling its record. */
export type LivePhase = 'running' | 'cancelling' | 'finishing'

export type LiveProgress = {
  schemaVersion: 1
  runId: string
  startedAt: string
  /** The `reeval run` process and the host it runs on, so a killed run can be told apart. */
  pid: number
  host: string
  /** Rewritten every few seconds while the run is alive. */
  heartbeatAt: string
  phase: LivePhase
  planned: number
  counts: LiveCounts
  attempts: LiveAttempt[]
  /** How the run was started, for a `--resume` after a quit that wrote no record. */
  invocation?: RunInvocation
}

/** A live run as the studio lists it: `stopped` when its process is gone or went quiet. */
export type LiveRun = Omit<LiveProgress, 'schemaVersion' | 'pid' | 'host' | 'heartbeatAt'> & {
  state: LivePhase | 'stopped'
}

export type LiveIndex = { runs: LiveRun[] }

export const liveApiPath = 'api/live'
export const liveTranscriptPath = (runId: string, attemptKey: string) =>
  `api/live/${runId}/transcript?attempt=${encodeURIComponent(attemptKey)}`

export const FINISHED: readonly LiveStatus[] = ['pass', 'fail', 'infra_error', 'skipped']
export const isFinished = (status: LiveStatus) => FINISHED.includes(status)

export function liveCounts(attempts: readonly Pick<LiveAttempt, 'status'>[]): LiveCounts {
  const count = (...statuses: LiveStatus[]) =>
    attempts.filter((a) => statuses.includes(a.status)).length
  return {
    done: count(...FINISHED),
    passed: count('pass'),
    failed: count('fail'),
    errored: count('infra_error'),
    skipped: count('skipped'),
    running: count('running'),
  }
}

const STATUSES: readonly LiveStatus[] = ['queued', 'running', ...FINISHED]
const PHASES: readonly LivePhase[] = ['running', 'cancelling', 'finishing']
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const orNull = <T>(v: unknown, is: (x: unknown) => x is T): v is T | null | undefined =>
  v === null || v === undefined || is(v)

function readableAttempt(v: unknown): LiveAttempt | null {
  if (!isObj(v)) return null
  const { key, evalId, name, file, cell, n, status, startedAt, durationMs } = v
  if (!str(key) || !str(evalId) || !str(name) || !str(file) || !str(cell) || !num(n)) return null
  if (!isOneOf(STATUSES, status)) return null
  if (!orNull(startedAt, str) || !orNull(durationMs, num)) return null
  return {
    key,
    evalId,
    name,
    file,
    cell,
    n,
    status,
    startedAt: startedAt ?? null,
    durationMs: durationMs ?? null,
  }
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(str)

/** A saved invocation, or undefined when it isn't one; its numbers are whole and at least 1. */
export function readableInvocation(v: unknown): RunInvocation | undefined {
  if (!isObj(v)) return undefined
  const { runs, profile, concurrency, filters, tags } = v
  const count = (n: unknown) => n === undefined || (Number.isInteger(n) && (n as number) >= 1)
  if (!count(runs) || !count(concurrency) || !(profile === undefined || str(profile)))
    return undefined
  if (!strings(filters) || !strings(tags)) return undefined
  return {
    ...(runs === undefined ? {} : { runs: runs as number }),
    ...(profile === undefined ? {} : { profile }),
    ...(concurrency === undefined ? {} : { concurrency: concurrency as number }),
    filters,
    tags,
  }
}

/**
 * A progress file as the studio reads it, or null when it isn't one it can read: half-written,
 * corrupt, or from a newer reeval. Counts are recomputed from the attempts, never trusted.
 */
export function readableLiveProgress(value: unknown): LiveProgress | null {
  if (!isObj(value) || value.schemaVersion !== LIVE_SCHEMA_VERSION) return null
  fillDefaults('live-progress', value)
  const { runId, startedAt, pid, host, heartbeatAt, phase, attempts } = value
  if (!str(runId) || !str(startedAt) || !str(host) || !str(heartbeatAt) || !num(pid)) return null
  if (!isOneOf(PHASES, phase) || !Array.isArray(attempts)) return null
  const list = attempts.map(readableAttempt)
  if (!list.every((a) => a !== null)) return null
  const invocation = readableInvocation(value.invocation)
  return {
    schemaVersion: LIVE_SCHEMA_VERSION,
    runId,
    startedAt,
    pid,
    host,
    heartbeatAt,
    phase,
    planned: list.length,
    counts: liveCounts(list),
    attempts: list,
    ...(invocation ? { invocation } : {}),
  }
}
