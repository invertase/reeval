import { realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { listRuns, scratchDir } from '../history/files.ts'
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

/**
 * The real path of the file at `base/...dirs/...rest`, when it lies inside `dirs` under `base`'s
 * real path; null otherwise. Only `base` is resolved before the check, so a symlink at `dirs` (a
 * run's directory) is refused rather than taken as the directory to stay inside.
 */
export async function fileInside(
  base: string,
  dirs: string[],
  rest: string[],
): Promise<string | null> {
  try {
    const [realBase, real] = await Promise.all([
      realpath(base),
      realpath(join(base, ...dirs, ...rest)),
    ])
    if (!real.startsWith(join(realBase, ...dirs) + sep)) return null
    return (await stat(real)).isFile() ? real : null
  } catch {
    return null
  }
}

/**
 * The file a record or artifact path names, or null. A run resolves to the history folder first,
 * then `.reeval/runs/`; the real path must stay inside that folder's directory for the run, so
 * neither a symlink inside the run nor a symlinked run directory can lead elsewhere.
 */
export async function resolveFile(
  source: StudioSource,
  target: Extract<DataTarget, { kind: 'record' | 'artifact' }>,
): Promise<string | null> {
  for (const dir of dirsOf(source)) {
    const record = await fileInside(dir, [], [`${target.runId}.json`])
    if (!record) continue
    if (target.kind === 'record') return record
    return fileInside(dir, [target.runId], target.segments)
  }
  return null
}
