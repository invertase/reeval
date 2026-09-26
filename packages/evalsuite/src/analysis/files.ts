// Where analyses live. The cache, `.es/analysis/<key>.json`, is gitignored and always written.
// A saved analysis is two new files in the run's history folder, `<run>/analysis/<stamp>_<author>_
// <hash8>.{json,md}`, written create-only: the record is never touched, so two teammates who save
// never conflict, and the static studio build picks them up with the run's other files.
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HistoryError, runDir } from '../history/files.ts'
import { countSecrets } from '../redact.ts'
import type { AnalysisDoc, AnalysisEntry } from '../view/analysis.ts'

export const analysisCacheDir = (root: string) => join(root, '.es', 'analysis')
export const savedAnalysisDir = (historyDir: string, runId: string) =>
  join(runDir(historyDir, runId), 'analysis')

const parse = (text: string): AnalysisDoc | null => {
  try {
    const doc = JSON.parse(text) as AnalysisDoc
    return doc?.kind === 'es-analysis' ? doc : null
  } catch {
    return null
  }
}

export async function readCached(root: string, key: string): Promise<AnalysisDoc | null> {
  const text = await readFile(join(analysisCacheDir(root), `${key}.json`), 'utf8').catch(() => null)
  return text === null ? null : parse(text)
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
  if (countSecrets(json) > 0 || countSecrets(markdown) > 0) {
    throw new HistoryError(
      'Refusing to save the analysis: it looks like it contains a secret. Check it with es analyze --json.',
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

/** Saved analyses of a run (newest first by name), and cached ones anchored on it when asked. */
export async function listAnalyses(
  root: string,
  historyDirs: string[],
  runId: string,
  withCache: boolean,
): Promise<AnalysisEntry[]> {
  const entries: AnalysisEntry[] = []
  for (const dir of historyDirs) {
    const folder = savedAnalysisDir(dir, runId)
    const names = (await readdir(folder).catch(() => [] as string[])).filter((n) =>
      n.endsWith('.json'),
    )
    for (const name of names.sort().reverse()) {
      const doc = parse(await readFile(join(folder, name), 'utf8').catch(() => ''))
      if (doc) entries.push({ file: `analysis/${name}`, source: 'saved', doc })
    }
    if (entries.length) break
  }
  if (withCache) {
    const cache = analysisCacheDir(root)
    for (const name of await readdir(cache).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue
      const doc = parse(await readFile(join(cache, name), 'utf8').catch(() => ''))
      if (doc?.anchor === runId)
        entries.push({ file: `.es/analysis/${name}`, source: 'cached', doc })
    }
  }
  return entries
}
