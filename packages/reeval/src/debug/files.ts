import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { evalSlug, RUN_ID } from '../ids.ts'

/** Local debug data, one directory per run. Gitignored with `.reeval/`, never recorded. */
export const debugRoot = (root: string) => join(root, '.reeval', 'debug')

/** An attempt's kept final workspace, in its debug directory. */
export const KEPT_WORKSPACE_FILE = 'workspace.tar.gz'

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

/** Runs with debug data, oldest first. */
export async function debugRuns(root: string): Promise<string[]> {
  try {
    return (await readdir(debugRoot(root))).filter((name) => RUN_ID.test(name)).sort()
  } catch {
    return []
  }
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

/** Removes every run's debug data but the newest `keep`; returns what it removed. */
export async function pruneDebug(
  root: string,
  keep: number,
): Promise<{ runs: string[]; bytes: number }> {
  const runs = await debugRuns(root)
  const removed = runs.slice(0, Math.max(0, runs.length - keep))
  let bytes = 0
  for (const runId of removed) {
    const dir = join(debugRoot(root), runId)
    bytes += await size(dir)
    await rm(dir, { recursive: true, force: true })
  }
  return { runs: removed, bytes }
}
