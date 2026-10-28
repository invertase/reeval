import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { type AssembleInput, assembleRun } from './history/assemble.ts'
import { scratchDir, type WrittenRun, writeRun } from './history/files.ts'
import { renderSummary } from './history/summary.ts'
import type { RunRecord } from './history/types.ts'
import type { ResolvedConfig } from './types.ts'
import { REMARKS_FILE, type RunRemarks } from './view/remarks.ts'

const STALE_STAGING_MS = 24 * 60 * 60 * 1000

/** Where workers write raw per-eval records before the run is assembled. */
export const stagingDir = (root: string, runId: string) => join(root, '.reeval', 'staging', runId)

/** Removes staging left behind by runs that were killed before they could clean up. */
export async function sweepStaging(root: string, keep?: string): Promise<void> {
  const dir = join(root, '.reeval', 'staging')
  const entries = await readdir(dir).catch(() => [])
  for (const name of entries) {
    if (name === keep) continue
    const age = await stat(join(dir, name)).then(
      (s) => Date.now() - s.mtimeMs,
      () => 0,
    )
    if (age > STALE_STAGING_MS) await rm(join(dir, name), { recursive: true, force: true })
  }
}

/**
 * The run's remarks, each marked with whether the run's output prints it, or null when it raised
 * none; they never stop the run being written.
 */
async function runRemarks(
  config: ResolvedConfig,
  record: RunRecord,
  verbose: boolean,
): Promise<RunRemarks | null> {
  try {
    const { remarksOf, remarksDoc } = await import('./remarks/index.ts')
    const { markPrinted } = await import('./ui/remarks.ts')
    const marked = markPrinted(await remarksOf(config, record), record.runId, verbose)
    return marked.length ? remarksDoc(record, marked) : null
  } catch (error) {
    process.stderr.write(`warning: no remarks for this run: ${(error as Error).message}\n`)
    return null
  }
}

/**
 * Assembles the run into `.reeval/runs/`, with every artifact, a summary.md and, when a finished
 * run raised remarks, its remarks.json.
 */
export async function writeScratchRun(
  input: AssembleInput,
  landed?: () => void,
): Promise<WrittenRun & { record: RunRecord; remarks: RunRemarks | null }> {
  const { record, artifacts, moves } = await assembleRun(input)
  const remarks = input.interrupted
    ? null
    : await runRemarks(input.ctx.config, record, (input.ctx.verbosity ?? 0) > 0)
  if (remarks) artifacts.set(REMARKS_FILE, Buffer.from(`${JSON.stringify(remarks, null, 2)}\n`))
  artifacts.set('summary.md', Buffer.from(renderSummary(record, { remarks })))
  const scratch = scratchDir(input.ctx.config.root)
  const written = await writeRun(scratch, record, artifacts, moves)
  landed?.()
  await rm(input.ctx.stagingDir, { recursive: true, force: true })
  return { ...written, record, remarks }
}
