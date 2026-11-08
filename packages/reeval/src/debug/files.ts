import { readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { evalSlug, RUN_ID } from '../ids.ts'

/**
 * Local debug data, one directory per run, and with `history.debugArchive` its zip beside it.
 * Gitignored with `.reeval/`, never recorded.
 */
export const debugRoot = (root: string) => join(root, '.reeval', 'debug')

/** A run's debug data as one zip (`history.debugArchive`). */
export const debugArchiveFile = (root: string, runId: string) =>
  join(debugRoot(root), `${runId}.zip`)

/** Where one attempt's debug data goes: the same layout as its artifacts in the run. */
export const attemptDebugDir = (
  root: string,
  runId: string,
  evalId: string,
  cellKey: string,
  n: number,
) => join(debugRoot(root), runId, evalSlug(evalId), evalSlug(cellKey), String(n))

/** `<eval> # <cell>#<n>`, the attempt key in a record, back into its parts. */
export function parseAttemptKey(key: string): { evalId: string; cell: string; n: number } | null {
  const split = key.lastIndexOf(' # ')
  if (split < 0) return null
  const attempt = key.slice(split + 3)
  const hash = attempt.lastIndexOf('#')
  const n = Number(attempt.slice(hash + 1))
  if (hash < 0 || !Number.isInteger(n) || n < 1) return null
  return { evalId: key.slice(0, split), cell: attempt.slice(0, hash), n }
}

/** Runs with debug data, a directory or its zip, oldest first. */
export async function debugRuns(root: string): Promise<string[]> {
  const names = await readdir(debugRoot(root)).catch((): string[] => [])
  const runs = new Set(names.map((n) => n.replace(/\.zip$/, '')).filter((n) => RUN_ID.test(n)))
  return [...runs].sort()
}

async function size(path: string): Promise<number> {
  const info = await stat(path).catch(() => null)
  if (!info) return 0
  if (!info.isDirectory()) return info.size
  const entries = await readdir(path).catch(() => [])
  let total = 0
  for (const name of entries) total += await size(join(path, name))
  return total
}

/** An attempt's snapshots in a run's directory in `.reeval/runs`: under each `<n>/snapshots`. */
async function snapshotDirs(dir: string, depth = 0): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const found: string[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const path = join(dir, e.name)
    if (e.name === 'snapshots' && depth > 0 && /^[1-9]\d*$/.test(basename(dir))) found.push(path)
    else found.push(...(await snapshotDirs(path, depth + 1)))
  }
  return found
}

/** Runs in `.reeval/runs` with snapshots, oldest first. */
async function snapshotRuns(root: string): Promise<string[]> {
  const entries = await readdir(join(root, '.reeval', 'runs'), { withFileTypes: true }).catch(
    () => [],
  )
  return entries
    .filter((e) => e.isDirectory() && RUN_ID.test(e.name))
    .map((e) => e.name)
    .sort()
}

/**
 * Removes every run's debug data and snapshots but the newest `keep` runs' (the rest of a run in
 * `.reeval/runs` stays); returns the runs it removed something of and how much.
 */
export async function pruneDebug(
  root: string,
  keep: number,
): Promise<{ runs: string[]; bytes: number }> {
  const older = (runs: string[]) => runs.slice(0, Math.max(0, runs.length - keep))
  const removed = new Set<string>()
  let bytes = 0
  const leftovers = (await readdir(debugRoot(root)).catch(() => [])).filter((n) =>
    n.startsWith('.tmp-'),
  )
  for (const runId of older(await debugRuns(root))) {
    // A debug archive cut short leaves its claim and temp zip, both named for the run.
    const temps = leftovers.filter((n) => n.includes(runId)).map((n) => join(debugRoot(root), n))
    for (const path of [join(debugRoot(root), runId), debugArchiveFile(root, runId), ...temps]) {
      bytes += await size(path)
      await rm(path, { recursive: true, force: true })
    }
    removed.add(runId)
  }
  for (const runId of older(await snapshotRuns(root))) {
    for (const dir of await snapshotDirs(join(root, '.reeval', 'runs', runId))) {
      bytes += await size(dir)
      await rm(dir, { recursive: true, force: true })
      removed.add(runId)
    }
  }
  return { runs: [...removed].sort(), bytes }
}
