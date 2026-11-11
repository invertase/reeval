/**
 * The studio's data API: the routes `reeval studio` serves from local run folders and a hosted
 * studio calls, with the shape each answers. Any other server of runs answers the same routes with
 * the same shapes, so a client can't tell which one it talks to.
 *
 *   POST /api/v1/pair                                       { token } → PairResponse
 *   GET  /api/v1/handshake                                  Handshake
 *   GET  /api/v1/runs?cursor&limit                          RunList, newest first
 *   GET  /api/v1/runs/:runId/view                           RunView
 *   GET  /api/v1/runs/:runId/attempts/:attemptKey           AttemptView
 *   GET  /api/v1/runs/:runId/attempts/:attemptKey/transcript?cursor&limit   AttemptTrace
 *   GET  /api/v1/runs/:runId/artifacts/*path                the file's bytes
 *
 * Every route but `pair` needs `Authorization: Bearer <session>`, the session `pair` returned
 * for the one-time pairing token. An attempt key is one path segment, percent-encoded.
 */

import type {
  ArtifactLevel,
  AttemptRecord,
  CellRecord,
  EvalEntry,
  FileRef,
  HistoryEntry,
  RunRecord,
} from '../history/types.ts'
import type { CellEffort } from './effort.ts'
import { parseTranscript, type TranscriptLine } from './model.ts'

/** The routes' version, in their prefix: a breaking change to a route or shape bumps it. */
export const STUDIO_API_VERSION = 1
/** The run view's version: it moves when `buildRunView` derives something new or differently. */
export const VIEW_VERSION = 1
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
  run: RunView
  attempt: AttemptView
  transcript: AttemptTrace
  artifact: Uint8Array
}
export type StudioRoute = keyof StudioRoutes
export const STUDIO_ROUTES: readonly StudioRoute[] = [
  'pair',
  'handshake',
  'runs',
  'run',
  'attempt',
  'transcript',
  'artifact',
]

// ── Shapes ─────────────────────────────────────────────────────────────────────────────────

/** An opaque position in a list: pass a page's `next` back as `cursor` for the page after it. */
export type Cursor = string
export type Page<T> = { items: T[]; next: Cursor | null }

export type PairRequest = { token: string }
export type PairResponse = { session: string; handshake: Handshake }

/** What a server of runs is and serves, so a client knows which routes and view it can read. */
export type Handshake = {
  api: typeof STUDIO_API_VERSION
  viewVersion: number
  /** The reeval that serves the runs. */
  reeval: string
  project: string
  routes: StudioRoute[]
  /** The run the user asked to open, when they named one, else the newest. */
  focus: string | null
}

export type RunListItem = HistoryEntry
export type RunList = Page<RunListItem>

/** One run, as a page draws it: the record's run-level fields and every eval's cells and attempts. */
export type RunView = {
  viewVersion: number
  header: RunListItem
  stack: RunRecord['stack']
  config: RunRecord['config']
  plan: RunRecord['plan']
  profile: RunRecord['profile']
  environments: RunRecord['environments']
  artifacts: ArtifactLevel
  errors: string[]
  evals: EvalView[]
}

export type EvalView = Pick<
  EvalEntry,
  | 'key'
  | 'id'
  | 'slug'
  | 'name'
  | 'file'
  | 'group'
  | 'tags'
  | 'outcome'
  | 'passRate'
  | 'fingerprint'
  | 'compare'
  | 'cases'
  | 'lifts'
> & {
  /** Every check label the eval's attempts asserted, in first-seen order. */
  checks: string[]
  cells: CellView[]
  attempts: AttemptSummary[]
}

export type CellView = CellRecord & {
  /** Tool calls, agent time, tokens and cost over the cell's attempts; null with none that ran. */
  effortStats: CellEffort | null
}

/** Facts read from an attempt's transcript; null on the attempt when it wasn't kept. */
export type AttemptFacts = {
  toolCalls: number
  byClass: Record<'context' | 'dependency' | 'web' | 'verify' | 'workspace', number>
  skills: Array<{
    skill: string
    source: string
    reads: number
    /** The transcript line of its first use. */
    firstLine: number
  }>
  contextFiles: Array<{ path: string; reads: number; firstLine: number }>
}

export type AttemptSummary = Pick<
  AttemptRecord,
  | 'key'
  | 'id'
  | 'cell'
  | 'case'
  | 'n'
  | 'outcome'
  | 'error'
  | 'startedAt'
  | 'durationMs'
  | 'usage'
  | 'servedModels'
  | 'effort'
  | 'servedEffort'
> & {
  evalKey: string
  assertions: { passed: number; failed: number }
  judgements: { passed: number; failed: number }
  facts: AttemptFacts | null
  /** Whether a transcript was kept, so `transcript` answers. */
  transcript: boolean
}

/** One attempt: its record without the turn-by-turn detail, which the transcript has. */
export type AttemptView = Omit<AttemptRecord, 'turns' | 'context'> & {
  evalKey: string
  turns: number
  contextFiles: number
  facts: AttemptFacts | null
  /** Every file kept for the attempt, by its path under `artifacts/`. */
  fileRefs: FileRef[]
}

export type AttemptTrace = Page<TranscriptLine> & { totalLines: number }

// ── Paths ──────────────────────────────────────────────────────────────────────────────────

const enc = encodeURIComponent

export const studioPaths = {
  pair: () => `${STUDIO_API_PREFIX}/pair`,
  handshake: () => `${STUDIO_API_PREFIX}/handshake`,
  runs: () => `${STUDIO_API_PREFIX}/runs`,
  run: (runId: string) => `${STUDIO_API_PREFIX}/runs/${runId}/view`,
  attempt: (runId: string, attemptKey: string) =>
    `${STUDIO_API_PREFIX}/runs/${runId}/attempts/${enc(attemptKey)}`,
  transcript: (runId: string, attemptKey: string) =>
    `${STUDIO_API_PREFIX}/runs/${runId}/attempts/${enc(attemptKey)}/transcript`,
  artifact: (runId: string, path: string) => `${STUDIO_API_PREFIX}/runs/${runId}/artifacts/${path}`,
} satisfies Record<StudioRoute, (...args: string[]) => string>

export type StudioTarget =
  | { route: 'pair' }
  | { route: 'handshake' }
  | { route: 'runs' }
  | { route: 'run'; runId: string }
  | { route: 'attempt'; runId: string; attemptKey: string }
  | { route: 'transcript'; runId: string; attemptKey: string }
  | { route: 'artifact'; runId: string; segments: string[] }

/**
 * What a request's pathname (as sent, still percent-encoded) names, or null. Run ids and
 * artifact segments must match an allowlist, so `.`, `..`, empty segments, backslashes and NUL
 * never get through; an attempt key is decoded once and may hold any character but NUL.
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
  if (kind === 'view' && rest.length === 0) return { route: 'run', runId }
  if (
    kind === 'attempts' &&
    (rest.length === 1 || (rest.length === 2 && rest[1] === 'transcript'))
  ) {
    let attemptKey: string
    try {
      attemptKey = decodeURIComponent(rest[0] as string)
    } catch {
      return null
    }
    if (!attemptKey || attemptKey.includes('\0')) return null
    return rest.length === 1
      ? { route: 'attempt', runId, attemptKey }
      : { route: 'transcript', runId, attemptKey }
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

/** One page of a transcript's lines; the cursor is the index of the page's first line. */
export function pageTranscript(
  transcript: string,
  query: { cursor?: string | null; limit?: string | null },
): AttemptTrace {
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
