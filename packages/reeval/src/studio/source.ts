import { realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { listRuns, recordFile, runDir, scratchDir } from '../history/files.ts'
import type { HistoryEntry } from '../history/types.ts'
import type { DataTarget } from '../view/paths.ts'

export type StudioSource = {
  root: string
  historyDir: string
  /** Also list unrecorded runs from `.reeval/runs/`, labelled as scratch. */
  scratch: boolean
}

/** Recorded runs, plus scratch runs that weren't recorded when enabled; oldest first. */
export async function listHeaders(source: StudioSource): Promise<HistoryEntry[]> {
  const kept = await listRuns(source.root, source.historyDir, true)
  if (!source.scratch) return kept
  const ids = new Set(kept.map((e) => e.runId))
  const scratch = await listRuns(source.root, scratchDir(source.root), false)
  return [...kept, ...scratch.filter((e) => !ids.has(e.runId))].sort((a, b) =>
    a.runId < b.runId ? -1 : 1,
  )
}

const dirsOf = (source: StudioSource) =>
  source.scratch ? [source.historyDir, scratchDir(source.root)] : [source.historyDir]

async function inside(base: string, path: string): Promise<string | null> {
  try {
    const [realBase, real] = await Promise.all([realpath(base), realpath(path)])
    if (!real.startsWith(realBase + sep)) return null
    return (await stat(real)).isFile() ? real : null
  } catch {
    return null
  }
}

/**
 * The file a record or artifact path names, or null. A run resolves to the history folder first,
 * then `.reeval/runs/`; the real path must stay inside that run's directory, so symlinks can't escape.
 */
export async function resolveFile(
  source: StudioSource,
  target: Extract<DataTarget, { kind: 'record' | 'artifact' }>,
): Promise<string | null> {
  for (const dir of dirsOf(source)) {
    const record = await inside(dir, recordFile(dir, target.runId))
    if (!record) continue
    if (target.kind === 'record') return record
    const artifacts = runDir(dir, target.runId)
    return inside(artifacts, join(artifacts, ...target.segments))
  }
  return null
}
