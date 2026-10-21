import type { SandboxWarning } from './types.ts'

/** `850ms`, `42s`, `3m 05s`: the CLI's and summary.md's durations. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** At most `max` characters, cut at a word boundary where there is one, marked with `…`. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.search(/\s\S*$/)
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** A failure's text keeps at most this much: its start (the reason) and its end (the output's tail). */
export const FAILURE_CAP = 16 * 1024

/** At most `max` characters: the start and the end, with how much was cut between them. */
export function capMiddle(text: string, max = FAILURE_CAP): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.75)
  const tail = max - head
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} characters cut …]\n${text.slice(-tail)}`
}

/**
 * A Markdown code block around `lines`. Its fence is one backtick longer than the longest run of
 * backticks in them (at least three), so no line inside can close it.
 */
export function fenced(lines: string[], lang = ''): string[] {
  const longest = Math.max(0, ...lines.flatMap((l) => (l.match(/`+/g) ?? []).map((m) => m.length)))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [`${fence}${lang}`, ...lines, fence]
}

/** How a sandbox warning prints: root in capitals, added capabilities softer. */
export const sandboxWarningLine = (w: SandboxWarning) =>
  `${w.kind === 'root' ? 'WARNING' : 'warning'}: ${w.message}`
