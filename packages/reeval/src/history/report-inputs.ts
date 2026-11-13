import { readdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { readAnalysisText } from '../analysis/files.ts'
import type { CapturePageFile } from '../types.ts'
import type { AnalysisDoc } from '../view/analysis.ts'
import { type AnalysisEntry, pinnedAnalysis, sortAnalyses } from '../view/analysis.ts'
import { type AttemptFacts, attemptFacts } from '../view/classify.ts'
import { transcriptByLine } from '../view/model.ts'
import { readableCapturePage, readableRemarks } from '../view/record.ts'
import { REMARKS_FILE, type RunRemarks } from '../view/remarks.ts'
import type { RunReportOptions } from '../view/report/index.ts'
import type { RunRecord } from './types.ts'

/**
 * Sidecars beside a recorded run directory for `buildRunReport`: remarks, the
 * pinned analysis, `.capture.json` page facts keyed by path and, given the run's record, each
 * attempt's facts from the transcript it kept. Only files whose real path is inside the run
 * directory count: a symlinked run directory has none, and a symlink inside it is skipped, as the
 * studio's artifacts route refuses both.
 */
export async function readReportInputs(
  runDir: string,
  record?: RunRecord,
): Promise<RunReportOptions> {
  const root = await realRunDir(runDir)
  if (!root) return { remarks: null, analysis: null }
  const read = async (path: string) => {
    const real = await realpath(path).catch(() => null)
    return real?.startsWith(root + sep) ? readFile(real, 'utf8').catch(() => null) : null
  }
  const remarks = await loadRemarks(read, join(runDir, REMARKS_FILE))
  const analysis = await loadPinnedAnalysis(read, join(runDir, 'analysis'))
  const pages = await loadCapturePages(read, runDir)
  const facts = record ? await loadFacts(read, runDir, record) : undefined
  return {
    remarks,
    analysis,
    pages: pages.size > 0 ? pages : undefined,
    ...(facts?.size ? { facts } : {}),
  }
}

/**
 * Each attempt's facts from the transcript.jsonl its record names, read one at a time, so a run
 * holds one transcript in memory at once, never all of them.
 */
async function loadFacts(
  read: Read,
  runDir: string,
  record: RunRecord,
): Promise<Map<string, AttemptFacts>> {
  const facts = new Map<string, AttemptFacts>()
  for (const e of record.evals) {
    for (const a of e.attempts) {
      const ref = a.files.transcript
      if (!ref) continue
      const text = await read(join(runDir, ...ref.path.split('/')))
      if (text !== null) facts.set(a.key, attemptFacts(record, a, transcriptByLine(text)))
    }
  }
  return facts
}

type Read = (path: string) => Promise<string | null>

/**
 * The run directory's path under its folder's real path; null when the directory itself is a
 * symlink (or its folder can't be read).
 */
async function realRunDir(runDir: string): Promise<string | null> {
  const folder = await realpath(dirname(runDir)).catch(() => null)
  if (!folder) return null
  const root = join(folder, basename(runDir))
  const real = await realpath(runDir).catch((e: NodeJS.ErrnoException) =>
    e.code === 'ENOENT' ? root : null,
  )
  return real === root ? root : null
}

async function loadRemarks(read: Read, file: string): Promise<RunRemarks | null> {
  const text = await read(file)
  if (text === null) return null
  try {
    return readableRemarks(JSON.parse(text) as RunRemarks)
  } catch {
    return null
  }
}

async function loadPinnedAnalysis(read: Read, dir: string): Promise<AnalysisDoc | null> {
  const names = await readdir(dir).catch((): string[] => [])
  const entries: AnalysisEntry[] = []
  for (const name of names
    .filter((n) => n.endsWith('.json'))
    .sort()
    .reverse()) {
    const text = await read(join(dir, name))
    if (text === null) continue
    const doc = readAnalysisText(text, join(dir, name))
    if (doc) entries.push({ file: name, source: 'saved', doc })
  }
  if (entries.length === 0) return null
  return pinnedAnalysis(sortAnalyses(entries))?.doc ?? entries[0]?.doc ?? null
}

async function loadCapturePages(read: Read, runDir: string): Promise<Map<string, CapturePageFile>> {
  const pages = new Map<string, CapturePageFile>()
  const stack: string[] = [runDir]
  while (stack.length) {
    const dir = stack.pop() as string
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.capture.json')) continue
      const text = await read(path)
      if (text === null) continue
      try {
        const page = readableCapturePage(JSON.parse(text) as CapturePageFile)
        const rel = path
          .slice(runDir.length + 1)
          .split('\\')
          .join('/')
        pages.set(rel, page)
      } catch {
        // Skip malformed capture pages.
      }
    }
  }
  return pages
}
