import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CapturePageFile } from '../types.ts'
import type { AnalysisDoc } from '../view/analysis.ts'
import { type AnalysisEntry, pinnedAnalysis, sortAnalyses } from '../view/analysis.ts'
import { readableAnalysis, readableCapturePage, readableRemarks } from '../view/record.ts'
import { REMARKS_FILE, type RunRemarks } from '../view/remarks.ts'
import type { RunReportOptions } from '../view/report/index.ts'

/**
 * Sidecars beside a recorded run directory for `buildRunReport`: remarks, the
 * pinned analysis, and `.capture.json` page facts keyed by path.
 */
export async function readReportInputs(runDir: string): Promise<RunReportOptions> {
  const remarks = await loadRemarks(join(runDir, REMARKS_FILE))
  const analysis = await loadPinnedAnalysis(join(runDir, 'analysis'))
  const pages = await loadCapturePages(runDir)
  return {
    remarks,
    analysis,
    pages: pages.size > 0 ? pages : undefined,
  }
}

async function loadRemarks(file: string): Promise<RunRemarks | null> {
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    return readableRemarks(JSON.parse(text) as RunRemarks)
  } catch {
    return null
  }
}

async function loadPinnedAnalysis(dir: string): Promise<AnalysisDoc | null> {
  const names = await readdir(dir).catch((): string[] => [])
  const entries: AnalysisEntry[] = []
  for (const name of names
    .filter((n) => n.endsWith('.json'))
    .sort()
    .reverse()) {
    const text = await readFile(join(dir, name), 'utf8').catch(() => null)
    if (text === null) continue
    try {
      const doc = readableAnalysis(JSON.parse(text) as AnalysisDoc)
      entries.push({ file: name, source: 'saved', doc })
    } catch {
      // Skip unreadable analyses; the report still renders without them.
    }
  }
  if (entries.length === 0) return null
  return pinnedAnalysis(sortAnalyses(entries))?.doc ?? entries[0]?.doc ?? null
}

async function loadCapturePages(runDir: string): Promise<Map<string, CapturePageFile>> {
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
      if (!entry.name.endsWith('.capture.json')) continue
      const text = await readFile(path, 'utf8').catch(() => null)
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
