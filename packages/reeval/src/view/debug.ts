/**
 * An attempt's local debug data, as `es run` writes it to `.es/debug/<runId>/<eval>/<cell>/<n>/`
 * and `es studio` serves it. Browser-safe. Never part of a record or the history folder.
 *
 *   debug.log        the `-v` trace, one line per event, always written
 *   requests.ndjson  one line per egress gateway request, always written
 *   trace.ndjson     raw payloads (`-vv`), written when the attempt fails or with `--trace`
 */

export const DEBUG_LOG = 'debug.log'
export const REQUESTS_FILE = 'requests.ndjson'
export const TRACE_FILE = 'trace.ndjson'

/** What part of the attempt a line is about, in the order an attempt goes through them. */
export const DEBUG_PHASES = [
  'plan',
  'image',
  'container',
  'env',
  'broker',
  'harness',
  'check',
  'judge',
  'gateway',
  'teardown',
  'docker',
] as const
export type DebugPhase = (typeof DEBUG_PHASES)[number]

/** One debug line: level 1 is `-v`, level 2 is `-vv` only. */
export type DebugLine = {
  at: number
  level: 1 | 2
  phase: DebugPhase
  text: string
  /** More lines under it, e.g. a docker command's output or a raw payload. */
  detail?: string
}

/** One raw trace entry: `ms` is since the attempt started. */
export type TraceEntry = { at: string; ms: number; phase: DebugPhase; kind: string; data: unknown }

/** One request through the egress gateway, or one tunnel it passed through without reading. */
export type DebugRequest = {
  at: string
  method: string
  url: string
  host: string
  port: number
  via: 'tunnel' | 'decrypted' | 'http'
  allowed: boolean
  status?: number
  reason?: string
  sent: number
  received: number
  /** Brokered secrets and the harness credential swapped in, by name. */
  substituted: string[]
  ms: number
}

/** What the studio's Debug tab shows for one attempt. */
export type DebugView = {
  lines: Array<{ at: string; phase: string; text: string }>
  requests: DebugRequest[]
  /** Whether `trace.ndjson` was kept. */
  trace: boolean
}

/**
 * The studio server's debug API (`es studio` only): an attempt's DebugView (null when it has no
 * local data), and its raw trace.
 */
export const debugApiPath = (runId: string, attemptKey: string) =>
  `api/debug/${runId}?attempt=${encodeURIComponent(attemptKey)}`
export const traceApiPath = (runId: string, attemptKey: string) =>
  `api/debug/${runId}/trace?attempt=${encodeURIComponent(attemptKey)}`

const PHASE_WIDTH = Math.max(...DEBUG_PHASES.map((p) => p.length))

/** `12:50:01`, or `12:50:01.234` with milliseconds, in UTC like every ES timestamp. */
export const debugTime = (at: number, ms: boolean) =>
  new Date(at).toISOString().slice(11, ms ? 23 : 19)

/** A line of debug.log: `2026-09-26T12:50:01.234Z plan      text`. */
export const debugLogLine = (line: Pick<DebugLine, 'at' | 'phase' | 'text'>) =>
  `${new Date(line.at).toISOString()} ${line.phase.padEnd(PHASE_WIDTH)} ${line.text}`

const LOG_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (\S+)\s+(.*)$/

/** debug.log's lines; a line that isn't one (a wrapped message) continues the one before. */
export function parseDebugLog(text: string): DebugView['lines'] {
  const lines: DebugView['lines'] = []
  for (const raw of text.split('\n')) {
    if (!raw) continue
    const m = LOG_LINE.exec(raw)
    const last = lines.at(-1)
    if (m?.[1] && m[2]) lines.push({ at: m[1], phase: m[2], text: m[3] ?? '' })
    else if (last) last.text += `\n${raw}`
  }
  return lines
}

export function parseNdjson<T>(text: string): T[] {
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return []
    try {
      return [JSON.parse(line) as T]
    } catch {
      return []
    }
  })
}

/** `512 B`, `1.2 KB`, `3.4 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The gateway line for a request: method, URL, status, allowed or blocked and why, bytes each way,
 * time, and which secrets were swapped in (by name).
 */
export function requestLine(r: Omit<DebugRequest, 'at'>): string {
  const verdict = r.allowed ? 'allowed' : `blocked: ${r.reason ?? 'refused'}`
  return [
    `${r.method} ${r.url} → ${r.status ?? '-'}`,
    verdict,
    `↑${formatBytes(r.sent)} ↓${formatBytes(r.received)}`,
    `${r.ms}ms`,
    r.substituted.length ? `substituted ${r.substituted.join(', ')}` : 'no key substituted',
    ...(r.allowed && r.reason ? [`error: ${r.reason}`] : []),
  ].join(' · ')
}
