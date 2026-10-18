// Runs in progress for `reeval studio`: each running `reeval run`'s `.reeval/staging/<runId>/live.json`,
// until its record lands. Only the local server reads these; a static build never has them.

import { existsSync } from 'node:fs'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, sep } from 'node:path'
import { recordFile, scratchDir } from '../history/files.ts'
import { recordFileName } from '../ids.ts'
import { redactSecrets } from '../redact.ts'
import type { EvalRecord } from '../types.ts'
import {
  isFinished,
  LIVE_FILE,
  type LiveProgress,
  type LiveRun,
  readableLiveProgress,
} from '../view/live.ts'
import { RUN_ID } from '../view/paths.ts'
import type { StudioSource } from './source.ts'

/** A live run whose heartbeat is older than this is shown as stopped. */
export const STALE_MS = 15_000

export const stagingRoot = (root: string) => join(root, '.reeval', 'staging')

export type LiveOptions = { now?: number; staleMs?: number }

/** Whether the process that wrote `progress` is gone, when it ran on this host. */
function exited(progress: LiveProgress): boolean {
  if (progress.host !== hostname()) return false
  try {
    process.kill(progress.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

async function readProgress(root: string, runId: string): Promise<LiveProgress | null> {
  const text = await readFile(join(stagingRoot(root), runId, LIVE_FILE), 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const progress = readableLiveProgress(JSON.parse(text))
    return progress?.runId === runId ? progress : null
  } catch {
    return null
  }
}

const landed = (source: StudioSource, runId: string) =>
  [source.historyDir, scratchDir(source.root)].some((dir) => existsSync(recordFile(dir, runId)))

/**
 * Every run in progress, newest first; one whose record has landed isn't, and one whose process
 * exited or went quiet is `stopped`. A progress file that can't be read is left out.
 */
export async function listLive(
  source: StudioSource,
  options: LiveOptions = {},
): Promise<LiveRun[]> {
  if (!source.scratch) return []
  const now = options.now ?? Date.now()
  const staleMs = options.staleMs ?? STALE_MS
  const names = await readdir(stagingRoot(source.root)).catch((): string[] => [])
  const runs: LiveRun[] = []
  for (const runId of names
    .filter((n) => RUN_ID.test(n))
    .sort()
    .reverse()) {
    const progress = await readProgress(source.root, runId)
    if (!progress || landed(source, runId)) continue
    const quiet = now - Date.parse(progress.heartbeatAt) > staleMs
    const { schemaVersion: _, pid: __, host: ___, heartbeatAt: ____, ...run } = progress
    runs.push({ ...run, state: quiet || exited(progress) ? 'stopped' : progress.phase })
  }
  return runs
}

/**
 * A finished attempt's transcript, as `transcript.jsonl` has it, from the record its worker staged;
 * null for an attempt that isn't live and finished, or a file outside the run's staging directory.
 */
export async function liveTranscript(
  source: StudioSource,
  runId: string,
  key: string,
): Promise<string | null> {
  if (!source.scratch || !RUN_ID.test(runId)) return null
  const progress = await readProgress(source.root, runId)
  const attempt = progress?.attempts.find((a) => a.key === key)
  if (!attempt || !isFinished(attempt.status)) return null
  const base = join(stagingRoot(source.root), runId)
  try {
    const [realBase, real] = await Promise.all([
      realpath(base),
      realpath(join(base, 'evals', recordFileName(key))),
    ])
    if (!real.startsWith(realBase + sep)) return null
    const record = JSON.parse(await readFile(real, 'utf8')) as EvalRecord
    const { transcriptLines } = await import('../history/assemble.ts')
    return redactSecrets(transcriptLines(record))
  } catch {
    return null
  }
}

/** Calls `onChange` with the live runs whenever they change, checking every `pollMs`. */
export function watchLive(source: StudioSource, onChange: (runs: LiveRun[]) => void, pollMs = 400) {
  let signature = ''
  let busy = false
  const check = async () => {
    if (busy) return
    busy = true
    try {
      const runs = await listLive(source)
      const next = JSON.stringify(runs)
      if (next !== signature) {
        const first = signature === ''
        signature = next
        if (!first) onChange(runs)
      }
    } finally {
      busy = false
    }
  }
  void check()
  const poll = setInterval(() => void check(), pollMs)
  poll.unref()
  return () => clearInterval(poll)
}
