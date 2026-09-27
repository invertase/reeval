import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { formatDuration, isFinished, type LiveAttempt, type LiveRun } from 'evalsuite/view'
import { ArrowLeft, CircleStop, FileText, Radio } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import {
  elapsed,
  LiveBadge,
  LiveProgressBar,
  LiveStatusIcon,
  liveStatusLabel,
  useNow,
} from '@/components/live'
import { EmptyState, ErrorState, PageHeaderSkeleton, RowsSkeleton } from '@/components/states'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { headersQuery, liveTranscriptQuery, recordQuery, useLiveRuns } from '@/lib/data'
import { formatDate, plural, timeAgo } from '@/lib/format'
import { Transcript } from './attempt/transcript'

const runRoute = getRouteApi('/live/$runId')
const attemptRoute = getRouteApi('/live/$runId/attempt')

/**
 * The live run, or where to go once it has landed: the index lists it as soon as its record is
 * written, and the live list drops it only after that.
 */
function useLiveRun(runId: string) {
  const live = useLiveRuns()
  const headers = useQuery(headersQuery)
  const run = live.runs.find((r) => r.runId === runId)
  const landed = !run && !!headers.data?.headers.some((h) => h.runId === runId)
  return {
    run,
    landed,
    isPending: live.isPending || headers.isPending,
    error: live.error ?? headers.error,
  }
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tabular mt-1 text-lg font-semibold tracking-tight">{children}</div>
    </div>
  )
}

function NotLive({ runId }: { runId: string }) {
  return (
    <EmptyState icon={Radio} title="This run isn't in progress">
      No running <span className="font-mono">es run</span> has the id{' '}
      <span className="font-mono">{runId}</span>, and no record of it has landed.{' '}
      <Link to="/" className="underline">
        Back to runs
      </Link>
    </EmptyState>
  )
}

function Duration({ attempt, run, now }: { attempt: LiveAttempt; run: LiveRun; now: number }) {
  if (attempt.durationMs !== null) return <>{formatDuration(attempt.durationMs)}</>
  if (attempt.status === 'running' && attempt.startedAt && run.state !== 'stopped') {
    return <>{formatDuration(Math.max(0, now - Date.parse(attempt.startedAt)))}</>
  }
  return <>–</>
}

export function LiveRunPage() {
  const { runId } = runRoute.useParams()
  const navigate = useNavigate()
  const now = useNow()
  const { run, landed, isPending, error } = useLiveRun(runId)
  useEffect(() => {
    if (landed) void navigate({ to: '/runs/$runId', params: { runId }, replace: true })
  }, [landed, navigate, runId])
  const byEval = useMemo(() => {
    const groups = new Map<string, LiveAttempt[]>()
    for (const a of run?.attempts ?? []) groups.set(a.evalId, [...(groups.get(a.evalId) ?? []), a])
    return [...groups.values()]
  }, [run])

  if (error) return <ErrorState error={error} />
  if (isPending || landed) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <RowsSkeleton rows={6} />
      </div>
    )
  }
  if (!run) return <NotLive runId={runId} />
  const stopped = run.state === 'stopped'

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
          <Link to="/">
            <ArrowLeft /> Runs
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold tracking-tight">
            {stopped ? 'Run stopped' : 'Run in progress'}
          </h2>
          <LiveBadge run={run} />
        </div>
        <p className="mt-1 flex flex-wrap gap-x-2 text-sm text-muted-foreground">
          <span title={formatDate(run.startedAt)}>Started {timeAgo(run.startedAt, now)}</span>
          <span>·</span>
          <span className="font-mono text-xs leading-5">{run.runId}</span>
        </p>
      </div>

      {stopped ? (
        <div className="flex gap-3 rounded-xl border border-infra/30 bg-infra/5 px-4 py-3 text-sm">
          <CircleStop className="mt-0.5 size-4 shrink-0 text-infra" />
          <p>
            This run stopped without writing a record: its <span className="font-mono">es run</span>{' '}
            exited or stopped responding. The attempts below are what finished before it did.
          </p>
        </div>
      ) : null}

      <div className="space-y-3">
        <LiveProgressBar run={run} className="h-2.5" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Finished">
            {run.counts.done}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              of {plural(run.planned, 'attempt')}
            </span>
          </Stat>
          <Stat label="Passed">
            <span className="text-pass">{run.counts.passed}</span>
          </Stat>
          <Stat label="Failed">
            <span className={run.counts.failed + run.counts.errored ? 'text-fail' : ''}>
              {run.counts.failed + run.counts.errored}
            </span>
          </Stat>
          <Stat label="Elapsed">{stopped ? 'Stopped' : elapsed(run, now)}</Stat>
        </div>
        {run.state === 'finishing' ? (
          <p className="text-sm text-muted-foreground">
            Every attempt has finished; writing the run's record.
          </p>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10" />
              <TableHead>Attempt</TableHead>
              <TableHead className="hidden md:table-cell">Cell</TableHead>
              <TableHead className="hidden sm:table-cell">Status</TableHead>
              <TableHead className="text-right">Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {byEval.flat().map((a) => {
              const open = isFinished(a.status) && a.status !== 'skipped'
              const label = `${a.name} · #${a.n}`
              return (
                <TableRow key={a.key} data-live-attempt={a.status}>
                  <TableCell className="pl-4">
                    <LiveStatusIcon status={a.status} stopped={stopped} />
                  </TableCell>
                  <TableCell>
                    {open ? (
                      <Link
                        to="/live/$runId/attempt"
                        params={{ runId }}
                        search={{ key: a.key }}
                        className="font-medium hover:underline"
                      >
                        {label}
                      </Link>
                    ) : (
                      <span className="font-medium">{label}</span>
                    )}
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      {a.file}
                      <span className="md:hidden"> · {a.cell}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs md:table-cell">{a.cell}</TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                    {stopped && a.status === 'running'
                      ? 'Stopped'
                      : stopped && a.status === 'queued'
                        ? 'Never started'
                        : liveStatusLabel[a.status]}
                  </TableCell>
                  <TableCell className="tabular pr-4 text-right text-muted-foreground">
                    <Duration attempt={a} run={run} now={now} />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

export function LiveAttemptPage() {
  const { runId } = attemptRoute.useParams()
  const { key = '' } = attemptRoute.useSearch()
  const navigate = useNavigate()
  const { run, landed, isPending, error } = useLiveRun(runId)
  const attempt = run?.attempts.find((a) => a.key === key)
  const transcript = useQuery({
    ...liveTranscriptQuery(runId, key),
    enabled: !!attempt && isFinished(attempt.status),
  })
  // Once the run lands, its record has the attempt, with every tab.
  const record = useQuery({ ...recordQuery(runId), enabled: landed })
  useEffect(() => {
    if (!record.data) return
    for (const e of record.data.evals) {
      const a = e.attempts.find((x) => x.key === key)
      if (a) {
        void navigate({
          to: '/runs/$runId/evals/$slug/attempts/$attempt',
          params: { runId, slug: e.slug, attempt: a.id },
          replace: true,
        })
        return
      }
    }
    void navigate({ to: '/runs/$runId', params: { runId }, replace: true })
  }, [record.data, key, navigate, runId])

  if (error) return <ErrorState error={error} />
  if (isPending || landed) return <RowsSkeleton rows={6} />
  if (!run) return <NotLive runId={runId} />
  if (!attempt) {
    return (
      <EmptyState icon={FileText} title="No such attempt">
        This run has no attempt <span className="font-mono">{key}</span>.
      </EmptyState>
    )
  }
  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
          <Link to="/live/$runId" params={{ runId }}>
            <ArrowLeft /> Run in progress
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <LiveStatusIcon status={attempt.status} className="size-5" />
          <h2 className="text-2xl font-semibold tracking-tight">{attempt.name}</h2>
          <span className="font-mono text-sm text-muted-foreground">
            {attempt.cell}#{attempt.n}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {liveStatusLabel[attempt.status]}
          {attempt.durationMs !== null ? ` in ${formatDuration(attempt.durationMs)}` : ''} · The
          diff, checks and judge tabs arrive with the run's record.
        </p>
      </div>
      {!isFinished(attempt.status) ? (
        <EmptyState icon={FileText} title="Not finished yet">
          The transcript is here once this attempt finishes.
        </EmptyState>
      ) : transcript.error ? (
        <EmptyState icon={FileText} title="No transcript">
          This attempt didn't write one.
        </EmptyState>
      ) : transcript.isPending ? (
        <RowsSkeleton rows={5} />
      ) : (
        <Transcript text={transcript.data} />
      )}
    </div>
  )
}
