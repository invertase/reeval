// Where analyses live. The cache, `.reeval/analysis/<key>.json`, is gitignored and always written.
// A saved analysis is two new files in the run's history folder, `<run>/analysis/<stamp>_<author>_
// <hash8>.{json,md}`, written create-only: the record is never touched, so two teammates who save
// never conflict.
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HistoryError, runDir } from '../history/files.ts'
import { fromCwd } from '../ids.ts'
import { countSecrets, findSecretsInJson } from '../redact.ts'
import { fileInside } from '../studio/source.ts'
import type { AnalysisDoc, AnalysisEntry } from '../view/analysis.ts'
import { parsedAnalysis } from '../view/analysis-schema.ts'
import { NewerSchemaError } from '../view/record.ts'

export const analysisCacheDir = (root: string) => join(root, '.reeval', 'analysis')
export const savedAnalysisDir = (historyDir: string, runId: string) =>
  join(runDir(historyDir, runId), 'analysis')

const warned = new Set<string>()

/**
 * An analysis file's `text` as this reeval reads it; null if it isn't an analysis, or (with a
 * warning, once per file) is newer or doesn't fit `AnalysisDoc`.
 */
export const readAnalysisText = (text: string, file: string): AnalysisDoc | null => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if ((value as { kind?: unknown } | null)?.kind !== 'reeval-analysis') return null
  try {
    return parsedAnalysis(value, fromCwd(file))
  } catch (error) {
    if (!warned.has(file)) {
      warned.add(file)
      const why =
        error instanceof NewerSchemaError
          ? `${fromCwd(file)}: ${error.reason}`
          : `${(error as Error).message}, so this reeval can't read it`
      process.stderr.write(`warning: skipped ${why}\n`)
    }
    return null
  }
}

/** The cached analysis for `key`; a failed run summary (one with `error`) is a miss. */
export async function readCached(root: string, key: string): Promise<AnalysisDoc | null> {
  const file = join(analysisCacheDir(root), `${key}.json`)
  const text = await readFile(file, 'utf8').catch(() => null)
  const doc = text === null ? null : readAnalysisText(text, file)
  return doc?.error === undefined ? doc : null
}

export async function writeCached(root: string, key: string, doc: AnalysisDoc): Promise<string> {
  const dir = analysisCacheDir(root)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${key}.json`)
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`)
  await rename(tmp, path)
  return path
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'unknown'

/** `20260926T104633Z`: the UTC second the analysis was made. */
const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

/**
 * Writes the saved pair under the run's `analysis/` folder, create-only. Refuses (and writes
 * nothing) when either file exists or when the text looks like it holds a secret.
 */
export async function saveAnalysis(
  historyDir: string,
  doc: AnalysisDoc,
  key: string,
  markdown: string,
): Promise<string[]> {
  const json = `${JSON.stringify(doc, null, 2)}\n`
  if (findSecretsInJson(json).length > 0 || countSecrets(markdown) > 0) {
    throw new HistoryError(
      'Refusing to save the analysis: it looks like it contains a secret. Check it with reeval analyze --json.',
    )
  }
  const dir = savedAnalysisDir(historyDir, doc.anchor)
  await mkdir(dir, { recursive: true })
  const name = `${stamp(doc.createdAt)}_${slug(doc.author)}_${key.slice(0, 8)}`
  const paths = [join(dir, `${name}.json`), join(dir, `${name}.md`)]
  const written: string[] = []
  try {
    await writeFile(paths[0] as string, json, { flag: 'wx' })
    written.push(paths[0] as string)
    await writeFile(paths[1] as string, markdown, { flag: 'wx' })
    written.push(paths[1] as string)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new HistoryError(
        `${name} is already saved for ${doc.anchor}. Saved analyses are never rewritten.`,
      )
    }
    throw error
  }
  return written
}

/**
 * Saved analyses of a run (newest first by name), and cached ones anchored on it when asked. A
 * saved one is read only from inside the run's own folder, so a symlinked run folder lists none.
 */
export async function listAnalyses(
  root: string,
  historyDirs: string[],
  runId: string,
  withCache: boolean,
): Promise<AnalysisEntry[]> {
  const entries: AnalysisEntry[] = []
  for (const dir of historyDirs) {
    const folder = savedAnalysisDir(dir, runId)
    const names = (await readdir(folder).catch((): string[] => [])).filter((n) =>
      n.endsWith('.json'),
    )
    for (const name of names.sort().reverse()) {
      const file = join(folder, name)
      const real = await fileInside(dir, [runId, 'analysis'], [name])
      if (!real) continue
      const doc = readAnalysisText(await readFile(real, 'utf8').catch(() => ''), file)
      if (doc) entries.push({ file: `analysis/${name}`, source: 'saved', doc })
    }
    if (entries.length) break
  }
  if (withCache) {
    const cache = analysisCacheDir(root)
    for (const name of await readdir(cache).catch((): string[] => [])) {
      if (!name.endsWith('.json')) continue
      const file = join(cache, name)
      const doc = readAnalysisText(await readFile(file, 'utf8').catch(() => ''), file)
      if (doc?.anchor === runId)
        entries.push({ file: `.reeval/analysis/${name}`, source: 'cached', doc })
    }
  }
  return entries
}
