// Where a run's insights live: `<history>/<run>/insights.json`, beside the record, or
// `.reeval/runs/<run>/insights.json` before it's recorded (`reeval record` copies them). Written
// create-only, so the record is never touched and two writers never overwrite each other.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HistoryError, runDir, scratchDir } from '../history/files.ts'
import { fromCwd } from '../ids.ts'
import { countSecrets } from '../redact.ts'
import { INSIGHTS_FILE, type RunInsights } from '../view/insights.ts'
import { NewerSchemaError, readableInsights } from '../view/record.ts'

export const insightsFile = (historyDir: string, runId: string) =>
  join(runDir(historyDir, runId), INSIGHTS_FILE)

/** A run's insights file: in the history folder once it's recorded, else beside the scratch run. */
export const runInsightsFile = (
  config: { root: string; history: { dir: string } },
  entry: { runId: string; recorded: boolean },
) =>
  entry.recorded
    ? insightsFile(config.history.dir, entry.runId)
    : join(scratchDir(config.root), entry.runId, INSIGHTS_FILE)

/** Writes the file create-only; refuses when it exists or looks like it holds a secret. */
export async function writeInsights(file: string, doc: RunInsights): Promise<void> {
  const json = `${JSON.stringify(doc, null, 2)}\n`
  if (countSecrets(json) > 0) {
    throw new HistoryError(
      `Refusing to write ${fromCwd(file)}: it looks like it contains a secret.`,
    )
  }
  await mkdir(join(file, '..'), { recursive: true })
  try {
    await writeFile(file, json, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new HistoryError(
        `${fromCwd(file)} already exists, and insights are never rewritten. Delete it to write new ones.`,
      )
    }
    throw error
  }
}

const warned = new Set<string>()

/**
 * The run's insights, or null when it has none. One from a newer reeval, or one that isn't JSON
 * (a merge conflict in the committed file), is skipped with a warning: the run prints without it.
 */
export async function readInsights(file: string): Promise<RunInsights | null> {
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
    const doc = JSON.parse(text) as RunInsights
    return doc?.kind === 'reeval-insights' ? readableInsights(doc, fromCwd(file)) : null
  } catch (error) {
    if (error instanceof NewerSchemaError) return skip(error.reason)
    return skip(`it isn't valid JSON (${(error as Error).message})`)
  }
}
