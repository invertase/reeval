// People's verdicts on a run's judgements: `<run>/overrides.json` beside the record, which is never
// rewritten. Readers (show, query, analyze, mcp) attach each to its judgement; `verdict` stays the
// judge's, and an attempt's outcome, pass rate and lift don't change.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fromCwd } from '../ids.ts'
import { NewerSchemaError, readableOverrides } from '../view/record.ts'
import type { OverridesFile, RunRecord } from './types.ts'

export const overridesPath = (dir: string, runId: string) => join(dir, runId, 'overrides.json')

const warned = new Set<string>()

/** The run's overrides file; null when there's none, or (said once) when it can't be read. */
export async function readOverrides(dir: string, runId: string): Promise<OverridesFile | null> {
  const path = overridesPath(dir, runId)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const file = JSON.parse(text) as OverridesFile
    if (file?.kind !== 'reeval-overrides' || !Array.isArray(file.overrides)) {
      throw new Error('not a reeval overrides file')
    }
    return readableOverrides(file, fromCwd(path))
  } catch (error) {
    if (!warned.has(path)) {
      warned.add(path)
      const why =
        error instanceof NewerSchemaError
          ? error.message
          : `unreadable (${(error as Error).message})`
      process.stderr.write(`warning: ignored ${fromCwd(path)}: ${why}\n`)
    }
    return null
  }
}

/** Attaches each override to its judgement, in place; the last one for a judgement wins. */
export function applyOverrides(record: RunRecord, file: OverridesFile | null): RunRecord {
  if (!file?.overrides.length) return record
  const attempts = new Map(record.evals.flatMap((e) => e.attempts.map((a) => [a.key, a])))
  for (const o of file.overrides) {
    const j = attempts.get(o.attempt)?.judgements.find((x) => x.key === o.judgement)
    if (j) j.override = { verdict: o.verdict, reason: o.reason, author: o.author, at: o.at }
  }
  return record
}

/** The record read from `dir`, with the run's overrides attached. */
export async function withOverrides(record: RunRecord, dir: string): Promise<RunRecord> {
  return applyOverrides(record, await readOverrides(dir, record.runId))
}

/** Adds or replaces the override for one judgement and writes the file whole. */
export async function writeOverride(
  dir: string,
  runId: string,
  entry: OverridesFile['overrides'][number],
): Promise<string> {
  const path = overridesPath(dir, runId)
  const file: OverridesFile = (await readOverrides(dir, runId)) ?? {
    kind: 'reeval-overrides',
    schemaVersion: 1,
    runId,
    overrides: [],
  }
  file.overrides = [
    ...file.overrides.filter(
      (o) => !(o.attempt === entry.attempt && o.judgement === entry.judgement),
    ),
    entry,
  ]
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`)
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true })
  }
  return path
}
