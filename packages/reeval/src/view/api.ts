/**
 * The studio's data API: the routes `reeval studio` serves from local run folders and a hosted
 * studio calls, with the shape each answers. Any other server of runs answers the same routes with
 * the same shapes, so a client can't tell which one it talks to.
 *
 *   POST /api/v1/pair                                       { token } → PairResponse
 *   GET  /api/v1/handshake                                  Handshake
 *   GET  /api/v1/runs?cursor&limit                          RunList, newest first
 *   GET  /api/v1/runs/:runId/report                         RunReportIndex
 *   GET  /api/v1/runs/:runId/report/evals/:evalId           EvalDetail
 *   GET  /api/v1/runs/:runId/artifacts/*path                the file's bytes
 *   GET  /api/v1/runs/:runId/artifacts/*path?cursor&limit   TranscriptPage, for a .jsonl file
 *
 * Every route but `pair` needs `Authorization: Bearer <session>`, the session `pair` returned
 * for the one-time pairing token. An eval id is one path segment, percent-encoded. An artifact
 * path is relative to the run's folder, as the record's `FileRef.path`s are; `<runId>.json`, the
 * one path outside it, is the run's record. The report's links point at the artifacts route.
 */

import type { HistoryEntry } from '../history/types.ts'
import { parseTranscript, type TranscriptLine } from './model.ts'
import type { EvalDetail, REPORT_VERSION, RunReportIndex } from './report/split.ts'

/** The routes' version, in their prefix: a breaking change to a route or shape bumps it. */
export const STUDIO_API_VERSION = 1
export const STUDIO_API_PREFIX = `/api/v${STUDIO_API_VERSION}`

export const RUN_ID = /^\d{8}T\d{6}Z_[0-9a-z]+_[0-9a-z-]+_[0-9a-z]{4}$/
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_DEPTH = 8

export const RUN_LIST_LIMIT = { default: 50, max: 100 }
export const TRANSCRIPT_LIMIT = { default: 500, max: 2000 }

/** The route names, each with what it answers. */
export type StudioRoutes = {
  pair: PairResponse
  handshake: Handshake
  runs: RunList
  report: RunReportIndex
  eval: EvalDetail
  artifact: Uint8Array | TranscriptPage
}
export type StudioRoute = keyof StudioRoutes
export const STUDIO_ROUTES: readonly StudioRoute[] = [
  'pair',
  'handshake',
  'runs',
  'report',
  'eval',
  'artifact',
]

// ── Shapes ─────────────────────────────────────────────────────────────────────────────────

/** An opaque position in a list: pass a page's `next` back as `cursor` for the page after it. */
export type Cursor = string
export type Page<T> = { items: T[]; next: Cursor | null }

export type PairRequest = { token: string }
export type PairResponse = { session: string; handshake: Handshake }

/** What a server of runs is and serves, so a client knows which routes and report it can read. */
export type Handshake = {
  api: typeof STUDIO_API_VERSION
  /** The newest `RunReport.reportVersion` the server answers with. */
  reportVersion: typeof REPORT_VERSION
  /** The reeval that serves the runs. */
  reeval: string
  project: string
  routes: StudioRoute[]
  /** The run the user asked to open, when they named one, else the newest. */
  focus: string | null
}

export type RunListItem = HistoryEntry
export type RunList = Page<RunListItem>

/** A page of a `.jsonl` artifact's lines; `next` and the cursor are line indexes. */
export type TranscriptPage = Page<TranscriptLine> & { totalLines: number }

// ── Paths ──────────────────────────────────────────────────────────────────────────────────

const enc = encodeURIComponent

export const studioPaths = {
  pair: () => `${STUDIO_API_PREFIX}/pair`,
  handshake: () => `${STUDIO_API_PREFIX}/handshake`,
  runs: () => `${STUDIO_API_PREFIX}/runs`,
  report: (runId: string) => `${STUDIO_API_PREFIX}/runs/${runId}/report`,
  eval: (runId: string, evalId: string) =>
    `${STUDIO_API_PREFIX}/runs/${runId}/report/evals/${enc(evalId)}`,
  artifact: (runId: string, path: string) => `${STUDIO_API_PREFIX}/runs/${runId}/artifacts/${path}`,
} satisfies Record<StudioRoute, (...args: string[]) => string>

/** Where a run's report links point: its files at the artifacts route, its record beside them. */
export const reportLinks = (runId: string) => ({
  base: studioPaths.artifact(runId, ''),
  record: studioPaths.artifact(runId, `${runId}.json`),
})

export type StudioTarget =
  | { route: 'pair' }
  | { route: 'handshake' }
  | { route: 'runs' }
  | { route: 'report'; runId: string }
  | { route: 'eval'; runId: string; evalId: string }
  | { route: 'artifact'; runId: string; segments: string[] }

/**
 * What a request's pathname (as sent, still percent-encoded) names, or null. Run ids and
 * artifact segments must match an allowlist, so `.`, `..`, empty segments, backslashes and NUL
 * never get through; an eval id is decoded once and may hold any character but NUL.
 */
export function parseStudioPath(pathname: string): StudioTarget | null {
  if (!pathname.startsWith(`${STUDIO_API_PREFIX}/`)) return null
  const parts = pathname.slice(STUDIO_API_PREFIX.length + 1).split('/')
  if (parts.length === 1) {
    if (parts[0] === 'pair') return { route: 'pair' }
    if (parts[0] === 'handshake') return { route: 'handshake' }
    if (parts[0] === 'runs') return { route: 'runs' }
    return null
  }
  const [area, runId, kind, ...rest] = parts as [string, string, string?, ...string[]]
  if (area !== 'runs' || !RUN_ID.test(runId)) return null
  if (kind === 'report' && rest.length === 0) return { route: 'report', runId }
  if (kind === 'report' && rest.length === 2 && rest[0] === 'evals') {
    let evalId: string
    try {
      evalId = decodeURIComponent(rest[1] as string)
    } catch {
      return null
    }
    if (!evalId || evalId.includes('\0')) return null
    return { route: 'eval', runId, evalId }
  }
  if (kind === 'artifacts' && rest.length > 0 && rest.length <= MAX_DEPTH) {
    if (!rest.every((s) => SEGMENT.test(s))) return null
    return { route: 'artifact', runId, segments: rest }
  }
  return null
}

/** A list's `limit` query value, clamped to the route's maximum; the default when absent or bad. */
export function pageLimit(
  raw: string | null | undefined,
  bounds: { default: number; max: number },
) {
  const n = raw ? Number(raw) : Number.NaN
  return Number.isInteger(n) && n > 0 ? Math.min(n, bounds.max) : bounds.default
}

/**
 * One page of runs, newest first, from every header oldest first as the history lists them. The
 * cursor is the last run id of the page before, so a run recorded meanwhile never shifts a page.
 */
export function pageRuns(
  oldestFirst: readonly RunListItem[],
  query: { cursor?: string | null; limit?: string | null },
): RunList {
  const limit = pageLimit(query.limit, RUN_LIST_LIMIT)
  const newest = [...oldestFirst].reverse()
  const cursor = query.cursor
  const from = cursor ? newest.findIndex((h) => h.runId < cursor) : 0
  const items = from < 0 ? [] : newest.slice(from, from + limit)
  const more = from >= 0 && from + limit < newest.length
  return { items, next: more ? (items.at(-1)?.runId ?? null) : null }
}

/**
 * One page of a `.jsonl` file's lines, each read as a transcript line (`parseTranscript`: a line
 * that isn't JSON is skipped); the cursor is the index of the page's first line.
 */
export function pageTranscript(
  transcript: string,
  query: { cursor?: string | null; limit?: string | null },
): TranscriptPage {
  const lines = parseTranscript(transcript)
  const start = Math.max(0, Number.parseInt(query.cursor ?? '0', 10) || 0)
  const end = start + pageLimit(query.limit, TRANSCRIPT_LIMIT)
  return {
    items: lines.slice(start, end),
    next: end < lines.length ? String(end) : null,
    totalLines: lines.length,
  }
}

const TYPES: Array<[RegExp, string]> = [
  [/\.json$/, 'application/json; charset=utf-8'],
  [/\.jsonl$/, 'application/json; charset=utf-8'],
  [/\.png$/, 'image/png'],
]

/** Artifacts are untrusted agent output: JSON stays JSON, PNGs are images, else plain text. */
export const artifactType = (name: string) =>
  TYPES.find(([re]) => re.test(name))?.[1] ?? 'text/plain; charset=utf-8'
