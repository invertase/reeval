// The running `reeval run`'s progress file, `.reeval/staging/<runId>/live.json`, for `reeval studio`. It's
// replaced whole (a temp file, then a rename), so a reader sees the old file or the new one.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { PlannedItem } from './engine/types.ts'
import type { EvalResult } from './ui/events.ts'
import {
  LIVE_FILE,
  LIVE_SCHEMA_VERSION,
  type LiveAttempt,
  type LivePhase,
  type LiveProgress,
  type LiveStatus,
  liveCounts,
} from './view/live.ts'

/** How often a live run rewrites its heartbeat; the studio calls it stopped after a few misses. */
export const HEARTBEAT_MS = 2000

export type LiveProgressOptions = {
  dir: string
  runId: string
  startedAt: Date
  planned: PlannedItem[]
  heartbeatMs?: number
  now?: () => Date
}

export type LiveProgressWriter = {
  start(key: string, at: number): void
  end(result: EvalResult): void
  phase(phase: LivePhase): void
  /** Stops the heartbeat; the file stays until the staging directory goes. */
  stop(): void
  /** Stops and removes the file: the run ended without a record. */
  remove(): void
  read(): LiveProgress
}

function finished(result: EvalResult): LiveStatus {
  const outcome = result.meta?.outcome
  if (result.state === 'skipped')
    return outcome === 'fail' || outcome === 'infra_error' ? outcome : 'skipped'
  if (outcome === 'infra_error') return 'infra_error'
  return result.state === 'passed' ? 'pass' : 'fail'
}

/** Sharing-violation codes Windows uses while a reader has `to` open. */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** How long a busy rename is retried. A studio poll holds the file for a few milliseconds. */
const BUSY_MS = 1000

type ReplaceHooks = {
  now?: () => number
  wait?: (ms: number) => void
  busyMs?: number
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Renames `from` over `to`. Windows refuses while a reader (`reeval studio`) has `to` open, for a
 * moment: try again for up to a second rather than drop the update.
 */
export function replace(
  from: string,
  to: string,
  rename = renameSync,
  hooks: ReplaceHooks = {},
): void {
  const now = hooks.now ?? Date.now
  const wait = hooks.wait ?? pause
  const deadline = now() + (hooks.busyMs ?? BUSY_MS)
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!code || !BUSY.has(code) || now() >= deadline) throw error
      wait(Math.min(attempt, 32))
    }
  }
}

/** Writes the file at once, then on every change and heartbeat. Write errors never fail the run. */
export function writeLiveProgress(options: LiveProgressOptions): LiveProgressWriter {
  const now = options.now ?? (() => new Date())
  const file = join(options.dir, LIVE_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  const attempts = new Map<string, LiveAttempt>(
    options.planned.map((p) => [
      p.key,
      {
        key: p.key,
        evalId: p.id,
        name: p.attempt.name,
        file: p.file,
        cell: p.attempt.cell.key,
        n: p.attempt.n,
        status: p.attempt.plan.skip ? 'skipped' : 'queued',
        startedAt: null,
        durationMs: null,
      },
    ]),
  )
  let phase: LivePhase = 'running'
  let stopped = false

  const read = (): LiveProgress => {
    const list = [...attempts.values()]
    return {
      schemaVersion: LIVE_SCHEMA_VERSION,
      runId: options.runId,
      startedAt: options.startedAt.toISOString(),
      pid: process.pid,
      host: hostname(),
      heartbeatAt: now().toISOString(),
      phase,
      planned: list.length,
      counts: liveCounts(list),
      attempts: list,
    }
  }
  const write = () => {
    if (stopped) return
    try {
      writeFileSync(tmp, JSON.stringify(read()))
      replace(tmp, file)
    } catch {}
  }

  try {
    mkdirSync(options.dir, { recursive: true })
  } catch {}
  write()
  const heartbeat = setInterval(write, options.heartbeatMs ?? HEARTBEAT_MS)
  heartbeat.unref()

  const stop = () => {
    stopped = true
    clearInterval(heartbeat)
  }
  return {
    start(key, at) {
      const a = attempts.get(key)
      if (!a) return
      a.status = 'running'
      a.startedAt = new Date(at).toISOString()
      write()
    },
    end(result) {
      const a = attempts.get(result.key)
      if (!a) return
      a.status = finished(result)
      a.durationMs = result.durationMs
      write()
    },
    phase(next) {
      phase = next
      write()
    },
    stop,
    remove() {
      stop()
      rmSync(file, { force: true })
      rmSync(tmp, { force: true })
    },
    read,
  }
}
