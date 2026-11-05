import {
  formatDuration,
  type Segment,
  type SegmentKind,
  segments,
  type TimeSplit,
  type TranscriptEvent,
  type TranscriptLine,
} from 'reeval/view'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export const SEGMENT: Record<SegmentKind, { label: string; color: string }> = {
  waiting: { label: 'Waiting', color: 'bg-infra' },
  tool: { label: 'Tools', color: 'bg-brand/70' },
  model: { label: 'Model', color: 'bg-drift/60' },
  other: { label: 'Other', color: 'bg-skip/35' },
}

const ORDER: SegmentKind[] = ['waiting', 'tool', 'model', 'other']

const splitMs = (split: TimeSplit, kind: SegmentKind) =>
  kind === 'waiting'
    ? split.waitingMs
    : kind === 'tool'
      ? split.toolMs
      : kind === 'model'
        ? (split.modelMs ?? 0)
        : split.otherMs

/** `0:17`: minutes and seconds on a timeline's axis. */
export const clock = (ms: number) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Each turn of a transcript with its events and length, for its segments. */
export function transcriptTurns(lines: TranscriptLine[]) {
  const turns = new Map<number, { events: TranscriptEvent[]; durationMs: number }>()
  for (const line of lines) {
    const turn = turns.get(line.turn) ?? { events: [], durationMs: 0 }
    turns.set(line.turn, turn)
    if (line.type === 'turn-end') turn.durationMs = line.durationMs
    else if (line.type !== 'prompt') turn.events.push(line as TranscriptEvent)
  }
  return [...turns.entries()].map(([turn, t]) => ({
    turn,
    durationMs: t.durationMs,
    segments: segments(t.events, t.durationMs),
  }))
}

/** Where a split's time went, a dot and total per kind; model left out when it wasn't seen. */
export function SplitLegend({ split, className }: { split: TimeSplit; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground', className)}>
      {ORDER.filter((k) => k !== 'model' || split.modelMs !== null).map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5" data-split={k}>
          <span className={cn('size-2 rounded-full', SEGMENT[k].color)} />
          {SEGMENT[k].label}{' '}
          <span className="tabular text-foreground">{formatDuration(splitMs(split, k))}</span>
        </span>
      ))}
    </div>
  )
}

/** A bar of segments in time, as wide as `totalMs` is of `scaleMs`. */
export function SegmentBar({
  segments: parts,
  totalMs,
  scaleMs = totalMs,
}: {
  segments: Segment[]
  totalMs: number
  scaleMs?: number
}) {
  const total = totalMs || 1
  return (
    <div className="relative h-3" data-timeline-bar>
      <div
        className="absolute inset-y-0 left-0 overflow-hidden rounded-sm bg-muted"
        style={{ width: `${Math.min(1, totalMs / (scaleMs || 1)) * 100}%` }}
      >
        {parts.map((s) => (
          <Tooltip key={`${s.kind}-${s.startMs}`}>
            <TooltipTrigger asChild>
              <div
                data-segment={s.kind}
                className={cn('absolute inset-y-0', SEGMENT[s.kind].color)}
                style={{
                  left: `${(s.startMs / total) * 100}%`,
                  width: `${((s.endMs - s.startMs) / total) * 100}%`,
                }}
              />
            </TooltipTrigger>
            <TooltipContent>
              {SEGMENT[s.kind].label} {clock(s.startMs)}–{clock(s.endMs)} ·{' '}
              {formatDuration(s.endMs - s.startMs)}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

/** A split as one bar, its kinds stacked in order: for a cell's medians, which have no times. */
export function SplitBar({ split, scaleMs }: { split: TimeSplit; scaleMs: number }) {
  let at = 0
  const parts = ORDER.flatMap((kind) => {
    const ms = splitMs(split, kind)
    if (ms <= 0) return []
    const s = { kind, startMs: at, endMs: at + ms }
    at += ms
    return [s]
  })
  return <SegmentBar segments={parts} totalMs={at} scaleMs={scaleMs} />
}

/** `0:00`, the middle and the end of a timeline's axis. */
export function Axis({ ms }: { ms: number }) {
  return (
    <div className="tabular flex justify-between text-[10px] text-muted-foreground">
      <span>0:00</span>
      <span>{clock(ms / 2)}</span>
      <span>{clock(ms)}</span>
    </div>
  )
}
