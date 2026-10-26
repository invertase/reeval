// Where a run's remarks live: `<history>/<run>/remarks.json`, beside the record, or
// `.reeval/runs/<run>/remarks.json` before it's recorded (`reeval record` copies them).
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runDir, scratchDir } from '../history/files.ts'
import { fromCwd } from '../ids.ts'
import { NewerSchemaError, readableRemarks } from '../view/record.ts'
import { REMARKS_FILE, type RunRemarks } from '../view/remarks.ts'

export const remarksFile = (historyDir: string, runId: string) =>
  join(runDir(historyDir, runId), REMARKS_FILE)

/** A run's remarks file: in the history folder once it's recorded, else beside the scratch run. */
export const runRemarksFile = (
  config: { root: string; history: { dir: string } },
  entry: { runId: string; recorded: boolean },
) =>
  entry.recorded
    ? remarksFile(config.history.dir, entry.runId)
    : join(scratchDir(config.root), entry.runId, REMARKS_FILE)

const warned = new Set<string>()

/**
 * The run's remarks, or null when it has none. One from a newer reeval, or one that isn't JSON
 * (a merge conflict in the committed file), is skipped with a warning: the run prints without it.
 */
export async function readRemarks(file: string): Promise<RunRemarks | null> {
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null) return null
  const skip = (reason: string) => {
    if (!warned.has(file)) {
      warned.add(file)
      process.stderr.write(`warning: skipped ${fromCwd(file)}: ${reason}\n`)
    }
    return null
  }
  try {
    const doc = JSON.parse(text) as RunRemarks
    return doc?.kind === 'reeval-remarks' ? readableRemarks(doc, fromCwd(file)) : null
  } catch (error) {
    if (error instanceof NewerSchemaError) return skip(error.reason)
    return skip(`it isn't valid JSON (${(error as Error).message})`)
  }
}
