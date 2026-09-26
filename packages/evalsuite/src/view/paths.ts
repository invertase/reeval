/**
 * The studio's data API is a file layout: `es studio` serves these relative paths and
 * `es studio build` writes them to disk, so the web client reads both the same way.
 *
 *   studio.json                         mode, project and features
 *   data/index/manifest.json            shard list and eval catalog
 *   data/index/<YYYY-MM>.json           run headers started that UTC month, newest first
 *   data/runs/<runId>.json              the record, byte for byte
 *   data/runs/<runId>/<artifact path>   artifacts, raw
 *   data/analysis/<runId>.json          the run's saved analyses (and, live, cached ones)
 */

export const RUN_ID = /^\d{8}T\d{6}Z_[0-9a-z]+_[0-9a-z-]+_[0-9a-z]{4}$/
const SHARD = /^\d{4}-\d{2}$/
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_DEPTH = 8

export const studioPath = 'studio.json'
export const manifestPath = 'data/index/manifest.json'
export const shardPath = (id: string) => `data/index/${id}.json`
export const recordPath = (runId: string) => `data/runs/${runId}.json`
export const artifactPath = (runId: string, path: string) => `data/runs/${runId}/${path}`

/** A shard id: the UTC month a run started in. */
export const shardOf = (startedAt: string) => startedAt.slice(0, 7)

export type DataTarget =
  | { kind: 'studio' }
  | { kind: 'manifest' }
  | { kind: 'shard'; id: string }
  | { kind: 'record'; runId: string }
  | { kind: 'analysis'; runId: string }
  | { kind: 'artifact'; runId: string; segments: string[] }

/**
 * Maps a request path (relative, without a leading slash, already percent-decoded once) to what
 * it names, or null. Every segment must match an allowlist, so `.`, `..`, empty segments,
 * backslashes and NUL never get through.
 */
export function parseDataPath(path: string): DataTarget | null {
  if (path === studioPath) return { kind: 'studio' }
  if (path === manifestPath) return { kind: 'manifest' }
  const parts = path.split('/')
  if (parts[0] !== 'data' || parts.length < 3) return null
  const [, area, first, ...rest] = parts as [string, string, string, ...string[]]
  if (area === 'index' && rest.length === 0 && first.endsWith('.json')) {
    const id = first.slice(0, -5)
    return SHARD.test(id) ? { kind: 'shard', id } : null
  }
  if (area === 'analysis' && rest.length === 0 && first.endsWith('.json')) {
    const runId = first.slice(0, -5)
    return RUN_ID.test(runId) ? { kind: 'analysis', runId } : null
  }
  if (area !== 'runs') return null
  if (rest.length === 0) {
    if (!first.endsWith('.json')) return null
    const runId = first.slice(0, -5)
    return RUN_ID.test(runId) ? { kind: 'record', runId } : null
  }
  if (!RUN_ID.test(first) || rest.length > MAX_DEPTH) return null
  if (!rest.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')) return null
  return { kind: 'artifact', runId: first, segments: rest }
}

const TYPES: Array<[RegExp, string]> = [
  [/\.json$/, 'application/json; charset=utf-8'],
  [/\.jsonl$/, 'application/json; charset=utf-8'],
]

/** Artifacts are untrusted agent output: JSON stays JSON, everything else is plain text. */
export const artifactType = (name: string) =>
  TYPES.find(([re]) => re.test(name))?.[1] ?? 'text/plain; charset=utf-8'
