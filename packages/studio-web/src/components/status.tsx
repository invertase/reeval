import type { Outcome, StackChange } from 'evalsuite/view'
import { formatPercent } from 'evalsuite/view'
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CircleX,
  GitCompareArrows,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const OUTCOME = {
  pass: {
    label: 'Passed',
    Icon: CircleCheck,
    text: 'text-pass',
    bg: 'bg-pass/10 text-pass border-pass/25',
  },
  fail: {
    label: 'Failed',
    Icon: CircleX,
    text: 'text-fail',
    bg: 'bg-fail/10 text-fail border-fail/25',
  },
  infra_error: {
    label: 'Infra error',
    Icon: CircleAlert,
    text: 'text-infra',
    bg: 'bg-infra/10 text-infra border-infra/30',
  },
  skipped: {
    label: 'Skipped',
    Icon: CircleDashed,
    text: 'text-skip',
    bg: 'bg-skip/10 text-skip border-skip/25',
  },
} satisfies Record<Outcome, unknown>

/** An outcome's look; one from a newer ES that this studio doesn't know shows as its name. */
const outcomeStyle = (outcome: Outcome) =>
  OUTCOME[outcome] ?? {
    label: String(outcome),
    Icon: CircleHelp,
    text: 'text-muted-foreground',
    bg: 'bg-muted text-muted-foreground',
  }

/** `missed` mutes a failure in an ungated cell, which doesn't fail the run. */
export function OutcomeIcon({
  outcome,
  missed = false,
  className,
}: {
  outcome: Outcome | null
  missed?: boolean
  className?: string
}) {
  if (!outcome) {
    return (
      <span
        className={cn(
          'inline-block size-4 rounded-full border border-dashed border-muted-foreground/40',
          className,
        )}
        role="img"
        aria-label="Not run"
      />
    )
  }
  const { Icon, text, label } = outcomeStyle(outcome)
  if (missed && outcome === 'fail') {
    return (
      <CircleMinus
        className={cn('size-4 shrink-0 text-muted-foreground', className)}
        aria-label="Missed, not gated"
      />
    )
  }
  return <Icon className={cn('size-4 shrink-0', text, className)} aria-label={label} />
}

export function OutcomeBadge({
  outcome,
  label,
  className,
}: {
  outcome: Outcome
  /** Shown instead of the outcome's own label, e.g. `Todo` for a placeholder. */
  label?: string
  className?: string
}) {
  const { bg, Icon, label: own } = outcomeStyle(outcome)
  return (
    <Badge variant="outline" className={cn(bg, className)}>
      <Icon />
      {label ?? own}
    </Badge>
  )
}

export const outcomeLabel = (o: Outcome) => outcomeStyle(o).label

/** A compact segmented bar: pass, fail, missed (ungated failures), infra, skipped. */
export function TallyBar({
  pass,
  fail,
  missed = 0,
  infra = 0,
  skipped = 0,
  className,
}: {
  pass: number
  fail: number
  missed?: number
  infra?: number
  skipped?: number
  className?: string
}) {
  const total = pass + fail + missed + infra + skipped
  if (total === 0) return <div className={cn('h-1.5 rounded-full bg-muted', className)} />
  const seg = (n: number, color: string) =>
    n > 0 ? <div className={color} style={{ width: `${(n / total) * 100}%` }} /> : null
  return (
    <div className={cn('flex h-1.5 overflow-hidden rounded-full bg-muted', className)}>
      {seg(pass, 'bg-pass')}
      {seg(fail, 'bg-fail')}
      {seg(missed, 'bg-muted-foreground/40')}
      {seg(infra, 'bg-infra')}
      {seg(skipped, 'bg-skip/50')}
    </div>
  )
}

export function PassRate({ rate, className }: { rate: number | null; className?: string }) {
  const tone =
    rate === null
      ? 'text-muted-foreground'
      : rate >= 0.999
        ? 'text-pass'
        : rate === 0
          ? 'text-fail'
          : 'text-infra'
  return <span className={cn('tabular font-medium', tone, className)}>{formatPercent(rate)}</span>
}

const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}`

/** Lift in points, with its 95% interval; muted when the interval spans 0. */
export function Lift({
  points,
  interval,
}: {
  points: number | null
  interval?: { lo: number; hi: number; withinNoise: boolean } | null
}) {
  if (points === null) return <span className="text-muted-foreground">–</span>
  const noise = interval?.withinNoise ?? false
  const tone = noise
    ? 'text-muted-foreground'
    : points > 0
      ? 'text-pass'
      : points < 0
        ? 'text-fail'
        : 'text-muted-foreground'
  return (
    <span className={cn('tabular font-medium', tone)}>
      {signed(points)} pts
      {interval ? (
        <span className="ml-1 text-[11px] font-normal text-muted-foreground">
          95% {signed(interval.lo)}…{signed(interval.hi)}
          {noise ? ' · within noise' : ''}
        </span>
      ) : null}
    </span>
  )
}

export function DriftBadge({ changes, evals = 0 }: { changes: StackChange[]; evals?: number }) {
  if (changes.length === 0 && evals === 0) return null
  const parts = [
    ...changes.map((c) => `${c.label}: ${c.base} → ${c.head}`),
    ...(evals ? [`${evals} eval${evals === 1 ? '' : 's'} changed (fingerprint)`] : []),
  ]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="cursor-default border-drift/30 bg-drift/10 text-drift">
          <GitCompareArrows />
          drift
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <p className="mb-1 font-medium">Changed since the previous run</p>
        <ul className="space-y-0.5">
          {parts.map((p) => (
            <li key={p} className="font-mono text-[11px] break-all">
              {p}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

/** Outcome squares, oldest to newest, for history strips. */
export function OutcomeStrip({
  items,
  size = 'md',
}: {
  items: Array<{ key: string; outcome: Outcome | null; changed?: boolean; title?: string }>
  size?: 'sm' | 'md'
}) {
  const color: Record<Outcome, string> = {
    pass: 'bg-pass',
    fail: 'bg-fail',
    infra_error: 'bg-infra',
    skipped: 'bg-skip/50',
  }
  return (
    <div className="flex items-center gap-[3px]">
      {items.map((item) => (
        <div key={item.key} className="flex items-center gap-[3px]">
          {item.changed ? (
            <div className="h-4 w-px bg-drift" title="Eval or stack changed" />
          ) : null}
          <div
            title={item.title}
            className={cn(
              'rounded-[3px]',
              size === 'sm' ? 'size-2.5' : 'size-3.5',
              item.outcome
                ? (color[item.outcome] ?? 'bg-muted-foreground/40')
                : 'border border-dashed border-muted-foreground/40',
            )}
          />
        </div>
      ))}
    </div>
  )
}
