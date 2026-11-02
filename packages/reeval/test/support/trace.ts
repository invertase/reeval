import type { RunTrace } from '../../src/history/trace.ts'

/**
 * What would make Perfetto misdraw or drop part of a trace: a slice with a bad time, slices on one
 * track that overlap without nesting, and attempts sharing a lane at once. Empty when it's sound.
 */
export function traceProblems(trace: RunTrace): string[] {
  const problems: string[] = []
  const byTrack = new Map<number, Array<{ name: string; start: number; end: number }>>()
  for (const e of trace.traceEvents) {
    if (!Number.isInteger(e.ts) || e.ts < 0) problems.push(`${e.name}: ts ${e.ts}`)
    if (e.ph !== 'X') continue
    if (!Number.isInteger(e.dur) || (e.dur as number) < 0) problems.push(`${e.name}: dur ${e.dur}`)
    const track = byTrack.get(e.tid) ?? []
    track.push({ name: e.name, start: e.ts, end: e.ts + (e.dur ?? 0) })
    byTrack.set(e.tid, track)
  }
  for (const [tid, slices] of byTrack) {
    const open: Array<{ name: string; end: number }> = []
    for (const s of slices.sort((x, y) => x.start - y.start || y.end - x.end)) {
      while (open.length && (open.at(-1)?.end as number) <= s.start) open.pop()
      const parent = open.at(-1)
      if (parent && s.end > parent.end)
        problems.push(`lane ${tid}: ${s.name} overlaps ${parent.name} without nesting`)
      if (s.end > s.start) open.push(s)
    }
  }
  const attempts = trace.traceEvents.filter((e) => e.ph === 'X' && e.cat === 'attempt')
  if (attempts.length !== trace.otherData.attempts)
    problems.push(`${attempts.length} attempt slices for ${trace.otherData.attempts} attempts`)
  return problems
}
