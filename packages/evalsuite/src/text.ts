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
