import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { type AssembleInput, assembleRun } from './history/assemble.ts'
import { scratchDir, type WrittenRun, writeRun } from './history/files.ts'
import { renderSummary } from './history/summary.ts'
import type { RunRecord } from './history/types.ts'

const STALE_STAGING_MS = 24 * 60 * 60 * 1000

/** Where workers write raw per-eval records before the run is assembled. */
export const stagingDir = (root: string, runId: string) => join(root, '.es', 'staging', runId)

/** Removes staging left behind by runs that were killed before they could clean up. */
export async function sweepStaging(root: string): Promise<void> {
  const dir = join(root, '.es', 'staging')
  const entries = await readdir(dir).catch(() => [])
  for (const name of entries) {
    const age = await stat(join(dir, name)).then(
      (s) => Date.now() - s.mtimeMs,
      () => 0,
    )
    if (age > STALE_STAGING_MS) await rm(join(dir, name), { recursive: true, force: true })
  }
}

/** Assembles the run into `.es/runs/`, with every artifact and a summary.md. */
export async function writeScratchRun(
  input: AssembleInput,
  landed?: () => void,
): Promise<WrittenRun & { record: RunRecord }> {
  const { record, artifacts } = await assembleRun(input)
  artifacts.set('summary.md', Buffer.from(renderSummary(record)))
  const written = await writeRun(scratchDir(input.ctx.config.root), record, artifacts)
  landed?.()
  await rm(input.ctx.stagingDir, { recursive: true, force: true })
  return { ...written, record }
}
