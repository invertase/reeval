import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { type AssembleInput, assembleRun } from './record/assemble.ts'
import { deriveStore } from './record/index-file.ts'
import type { RunRecord } from './record/types.ts'
import { localStore } from './store/local.ts'

const STALE_STAGING_MS = 24 * 60 * 60 * 1000

/** Where workers write raw per-eval records before the run directory is assembled. */
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

/** Assembles the run directory into the local store and returns the record and its path. */
export async function writeRun(input: AssembleInput): Promise<{ record: RunRecord; path: string }> {
  const { record, dir, files } = await assembleRun(input)
  const store = localStore({ root: input.ctx.config.root })
  await store.commit({ files, derive: deriveStore, message: `es: run ${record.runId}` })
  await rm(input.ctx.resultsDir, { recursive: true, force: true })
  return { record, path: join(store.dir, ...dir.split('/')) }
}
