// Runs in progress for `reeval studio`: each running `reeval run`'s `.reeval/staging/<runId>/live.json`,
// until its record lands.

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { recordFile, scratchDir } from '../history/files.ts'
import { RUN_ID } from '../view/api.ts'
import { LIVE_FILE, type LiveProgress, type LiveRun, readableLiveProgress } from '../view/live.ts'
import { fileInside, type StudioSource } from './source.ts'

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
  const file = await fileInside(stagingRoot(root), [runId], [LIVE_FILE])
  const text = file && (await readFile(file, 'utf8').catch(() => null))
  if (!text) return null
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
