import { Link } from '@tanstack/react-router'
import { LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatDuration, type LiveRun, type LiveStatus } from 'reeval/view'
import { OutcomeIcon } from '@/components/status'
import { Badge } from '@/components/ui/badge'
import { formatDate, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

const STATE = {
  running: { label: 'Running', tone: 'border-brand/30 bg-brand/10 text-brand' },
  cancelling: { label: 'Cancelling', tone: 'border-infra/30 bg-infra/10 text-infra' },
  finishing: { label: 'Finishing', tone: 'border-brand/30 bg-brand/10 text-brand' },
  stopped: { label: 'Stopped', tone: 'border-border bg-muted text-muted-foreground' },
} satisfies Record<LiveRun['state'], unknown>

/** The current time, every second while mounted. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

/** `Running 3/6`: what the run is doing, and how many attempts have finished. */
export function LiveBadge({ run, className }: { run: LiveRun; className?: string }) {
  const { label, tone } = STATE[run.state]
  return (
    <Badge variant="outline" className={cn('gap-1.5 tabular', tone, className)}>
      {run.state === 'stopped' ? (
        <span className="size-1.5 rounded-full bg-muted-foreground/60" />
      ) : (
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      )}
      {label} {run.counts.done}/{run.planned}
    </Badge>
  )
}

/** Finished attempts by outcome, running ones pulsing, the rest still to go. */
export function LiveProgressBar({ run, className }: { run: LiveRun; className?: string }) {
  const { passed, failed, errored, skipped, running, done } = run.counts
  const total = Math.max(run.planned, 1)
  const seg = (n: number, color: string) =>
    n > 0 ? (
      <div
        className={cn('transition-[width] duration-500', color)}
        style={{ width: `${(n / total) * 100}%` }}
      />
    ) : null
  return (
    <div
      className={cn('flex h-2 overflow-hidden rounded-full bg-muted', className)}
      role="progressbar"
      aria-label="Attempts finished"
      aria-valuemin={0}
      aria-valuemax={run.planned}
      aria-valuenow={done}
    >
      {seg(passed, 'bg-pass')}
      {seg(failed, 'bg-fail')}
      {seg(errored, 'bg-infra')}
      {seg(skipped, 'bg-skip/50')}
      {run.state === 'stopped' ? null : seg(running, 'animate-pulse bg-brand/40')}
    </div>
  )
}

export function LiveStatusIcon({
  status,
  stopped = false,
  className,
}: {
  status: LiveStatus
  stopped?: boolean
  className?: string
}) {
  if (status === 'running' && !stopped) {
    return (
      <LoaderCircle
        className={cn('size-4 shrink-0 animate-spin text-brand', className)}
        aria-label="Running"
      />
    )
  }
  if (status === 'queued' || status === 'running') {
    return <OutcomeIcon outcome={null} className={className} />
  }
  return <OutcomeIcon outcome={status} className={className} />
}

export const liveStatusLabel: Record<LiveStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  pass: 'Passed',
  fail: 'Failed',
  infra_error: 'Infra error',
  skipped: 'Skipped',
}

/** How long the run has gone so far. */
export const elapsed = (run: LiveRun, now: number) =>
  formatDuration(Math.max(0, now - Date.parse(run.startedAt)))

/** The runs in progress, above the runs list. */
export function LiveRuns({ runs }: { runs: LiveRun[] }) {
  const now = useNow()
  if (!runs.length) return null
  return (
    <section aria-label="Runs in progress" className="space-y-2">
      {runs.map((run) => (
        <Link
          key={run.runId}
          to="/live/$runId"
          params={{ runId: run.runId }}
          data-live-run={run.runId}
          className="block rounded-xl border bg-card px-4 py-3 transition-colors hover:bg-accent/50"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <LiveBadge run={run} />
            <span className="text-sm font-medium" title={formatDate(run.startedAt)}>
              Started {timeAgo(run.startedAt, now)}
            </span>
            <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
              {run.runId}
            </span>
            <span className="tabular ml-auto text-xs text-muted-foreground">
              {run.counts.passed} passed · {run.counts.failed + run.counts.errored} failed
              {run.state !== 'stopped' && run.counts.running
                ? ` · ${run.counts.running} running`
                : ''}{' '}
              · {elapsed(run, now)}
            </span>
          </div>
          <LiveProgressBar run={run} className="mt-2.5" />
        </Link>
      ))}
    </section>
  )
}
