import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import {
  type AttemptRecord,
  activityLabel,
  findAttempt,
  findEval,
  formatDuration,
  formatUsage,
} from 'evalsuite/view'
import { ChevronLeft, ChevronRight, SearchX } from 'lucide-react'
import { Artifact } from '@/components/artifact'
import { EmptyState, ErrorState, PageHeaderSkeleton, RowsSkeleton } from '@/components/states'
import { OutcomeBadge, OutcomeIcon } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { debugQuery, recordQuery, useStudio } from '@/lib/data'
import { plural, shortRunId } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Checks } from './checks'
import { Debug } from './debug'
import { Diff } from './diff'
import { Judge } from './judge'
import { State } from './state'
import { Transcript } from './transcript'

export const TABS = ['transcript', 'diff', 'checks', 'judge', 'state', 'debug'] as const
export type Tab = (typeof TABS)[number]

const route = getRouteApi('/runs/$runId/evals/$slug/attempts/$attempt')

const PHASES = [
  ['setupMs', 'Setup', 'bg-skip/60'],
  ['agentMs', 'Agent', 'bg-brand'],
  ['diffMs', 'Diff', 'bg-drift/70'],
  ['checksMs', 'Checks', 'bg-infra'],
  ['judgeMs', 'Judge', 'bg-pass'],
] as const

function Timings({ attempt }: { attempt: AttemptRecord }) {
  const total = PHASES.reduce((n, [k]) => n + attempt.timings[k], 0) || 1
  return (
    <div className="space-y-2">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        {PHASES.map(([k, label, color]) =>
          attempt.timings[k] > 0 ? (
            <Tooltip key={k}>
              <TooltipTrigger asChild>
                <div
                  className={color}
                  style={{ width: `${(attempt.timings[k] / total) * 100}%` }}
                />
              </TooltipTrigger>
              <TooltipContent>
                {label} {formatDuration(attempt.timings[k])}
              </TooltipContent>
            </Tooltip>
          ) : null,
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {PHASES.map(([k, label, color]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className={cn('size-2 rounded-full', color)} />
            {label}{' '}
            <span className="tabular text-foreground">{formatDuration(attempt.timings[k])}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

export function AttemptPage() {
  const { runId, slug, attempt: attemptId } = route.useParams()
  const { tab = 'transcript' } = route.useSearch()
  const navigate = useNavigate({ from: '/runs/$runId/evals/$slug/attempts/$attempt' })
  const { data: record, error, isPending } = useQuery(recordQuery(runId))
  const { data: studio } = useStudio()
  const found = record && findEval(record, slug)
  const key = (found && findAttempt(found, attemptId)?.key) ?? ''
  // Only `es studio` serves .es/debug, and only for attempts that wrote it.
  const { data: debug } = useQuery(debugQuery(runId, key, !!studio?.features.debug && !!key))

  if (error) return <ErrorState error={error} />
  if (isPending) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <RowsSkeleton rows={6} />
      </div>
    )
  }
  const entry = findEval(record, slug)
  const attempt = entry && findAttempt(entry, attemptId)
  if (!entry || !attempt) {
    return (
      <EmptyState icon={SearchX} title="Attempt not found">
        This run has no attempt <code className="font-mono">{attemptId}</code> of that eval.{' '}
        <Link to="/runs/$runId" params={{ runId }} className="underline">
          Back to the run
        </Link>
      </EmptyState>
    )
  }
  const index = entry.attempts.indexOf(attempt)
  const prev = entry.attempts[index - 1]
  const next = entry.attempts[index + 1]
  const judge = attempt.judgements[0]
  const failedChecks = attempt.checks.filter((c) => c.exitCode !== 0).length
  const served = [...new Set(attempt.turns.flatMap((t) => (t.model ? [t.model] : [])))]

  return (
    <div className="space-y-6">
      <nav className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Runs
        </Link>
        <ChevronRight className="size-3.5" />
        <Link
          to="/runs/$runId"
          params={{ runId }}
          className="font-mono text-xs hover:text-foreground"
        >
          {shortRunId(runId)}
        </Link>
        <ChevronRight className="size-3.5" />
        <Link
          to="/runs/$runId"
          params={{ runId }}
          search={{ eval: slug }}
          className="max-w-64 truncate hover:text-foreground"
        >
          {entry.name}
        </Link>
        <ChevronRight className="size-3.5" />
        <span className="font-mono text-xs text-foreground">{attempt.id}</span>
      </nav>

      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="font-mono text-xs text-muted-foreground">
            {[entry.file, ...entry.group].join(' › ')}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">{entry.name}</h1>
            <OutcomeBadge outcome={attempt.outcome} />
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            <span className="font-mono text-xs">{attempt.id}</span> ·{' '}
            {formatDuration(attempt.durationMs)} · {plural(attempt.turns.length, 'turn')} ·{' '}
            {activityLabel(attempt.activity)}
            {attempt.activity.reasoningMs
              ? ` · ${formatDuration(attempt.activity.reasoningMs)} reasoning`
              : ''}
            {attempt.usage ? ` · ${formatUsage(attempt.usage)} tokens` : ''}
            {served.length ? ` · served by ${served.join(', ')}` : ''}
          </p>
        </div>
        {entry.attempts.length > 1 ? (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={!prev}
              asChild={!!prev}
            >
              {prev ? (
                <Link
                  to="."
                  params={{ runId, slug, attempt: prev.id }}
                  search={{ tab }}
                  aria-label="Previous attempt"
                >
                  <ChevronLeft />
                </Link>
              ) : (
                <ChevronLeft />
              )}
            </Button>
            <div className="flex items-center gap-0.5 px-1">
              {entry.attempts.map((a) => (
                <Link
                  key={a.id}
                  to="."
                  params={{ runId, slug, attempt: a.id }}
                  search={{ tab }}
                  title={a.id}
                  className={cn(
                    'rounded p-0.5',
                    a.id === attempt.id ? 'bg-accent ring-1 ring-border' : 'hover:bg-accent/60',
                  )}
                >
                  <OutcomeIcon outcome={a.outcome} className="size-3.5" />
                </Link>
              ))}
            </div>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={!next}
              asChild={!!next}
            >
              {next ? (
                <Link
                  to="."
                  params={{ runId, slug, attempt: next.id }}
                  search={{ tab }}
                  aria-label="Next attempt"
                >
                  <ChevronRight />
                </Link>
              ) : (
                <ChevronRight />
              )}
            </Button>
          </div>
        ) : null}
      </div>

      {attempt.error ? (
        <div className="rounded-lg border border-fail/30 bg-fail/5 px-4 py-3">
          <div className="text-xs font-medium tracking-wide text-fail uppercase">
            {attempt.error.kind}
          </div>
          <pre className="mt-1 max-h-60 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-fail">
            {attempt.error.message}
          </pre>
        </div>
      ) : null}

      <div className="rounded-xl border bg-card p-4">
        <Timings attempt={attempt} />
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => navigate({ search: { tab: v as Tab }, replace: true })}
      >
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="transcript">Transcript</TabsTrigger>
          <TabsTrigger value="diff">
            Diff
            {attempt.changedFiles.length ? (
              <span className="tabular text-xs text-muted-foreground">
                {attempt.changedFiles.length}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="checks">
            Checks
            {attempt.checks.length ? (
              <span
                className={cn(
                  'tabular text-xs',
                  failedChecks ? 'text-fail' : 'text-muted-foreground',
                )}
              >
                {failedChecks ? `${failedChecks}/${attempt.checks.length}` : attempt.checks.length}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="judge">
            Judge
            {judge ? (
              <span
                className={cn(
                  'tabular text-xs',
                  judge.verdict === 'pass' ? 'text-pass' : 'text-fail',
                )}
              >
                {judge.score.toFixed(2)}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="state">State</TabsTrigger>
          {debug ? <TabsTrigger value="debug">Debug</TabsTrigger> : null}
        </TabsList>
        <div className="mt-4">
          <TabsContent value="transcript">
            <Artifact record={record} file={attempt.files.transcript} what="transcript">
              {(text) => <Transcript key={attempt.id} text={text} />}
            </Artifact>
          </TabsContent>
          <TabsContent value="diff">
            <Artifact record={record} file={attempt.files.diff} what="diff">
              {(text) => <Diff key={attempt.id} text={text} />}
            </Artifact>
          </TabsContent>
          <TabsContent value="checks">
            <Checks record={record} attempt={attempt} />
          </TabsContent>
          <TabsContent value="judge">
            <Judge record={record} attempt={attempt} />
          </TabsContent>
          <TabsContent value="state">
            <State record={record} attempt={attempt} />
          </TabsContent>
          {debug ? (
            <TabsContent value="debug">
              <Debug runId={runId} attemptKey={attempt.key} view={debug} />
            </TabsContent>
          ) : null}
        </div>
      </Tabs>
    </div>
  )
}
