import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { Bot, GitBranch, History, Search, User } from 'lucide-react'
import { useMemo } from 'react'
import {
  formatDuration,
  formatPercent,
  formatUsage,
  type HistoryEntry,
  type RunRow,
  runOutcome,
  runRows,
  shortSha,
} from 'reeval/view'
import { LiveRuns } from '@/components/live'
import { Code, EmptyState, ErrorState, PageHeaderSkeleton, RowsSkeleton } from '@/components/states'
import { DriftBadge, OutcomeIcon, TallyBar } from '@/components/status'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { headersQuery, useLiveRuns, useStudio } from '@/lib/data'
import { formatDate, plural, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

const route = getRouteApi('/')

function Who({ entry }: { entry: HistoryEntry }) {
  if (entry.ci) {
    const badge = (
      <Badge variant="secondary" className="gap-1 font-normal">
        <Bot /> {entry.ci.provider}
      </Badge>
    )
    return entry.ci.runUrl ? (
      <a
        href={entry.ci.runUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        {badge}
      </a>
    ) : (
      badge
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <User className="size-3.5" />
      {entry.author}
    </span>
  )
}

function Filters({ hasScratch }: { hasScratch: boolean }) {
  const search = route.useSearch()
  const navigate = useNavigate({ from: '/' })
  const set = (patch: Partial<typeof search>) =>
    navigate({ search: (s) => ({ ...s, ...patch }), replace: true })
  const Seg = ({ value, label }: { value: typeof search.status; label: string }) => (
    <button
      type="button"
      onClick={() => set({ status: value })}
      className={cn(
        'rounded-md px-3 py-1 text-sm transition-colors',
        search.status === value
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  )
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="relative sm:w-80">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search.q ?? ''}
          onChange={(e) => set({ q: e.target.value || undefined })}
          placeholder="Filter by branch, commit, author or run id"
          className="h-9 pl-8"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg bg-muted p-0.5">
          <Seg value={undefined} label="All" />
          <Seg value="failed" label="Failing" />
          <Seg value="passed" label="Passing" />
        </div>
        {hasScratch ? (
          <div className="inline-flex rounded-lg bg-muted p-0.5">
            {(
              [
                [undefined, 'Everything'],
                ['recorded', 'Recorded'],
                ['scratch', 'Scratch'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={label}
                type="button"
                onClick={() => set({ source: value })}
                className={cn(
                  'rounded-md px-3 py-1 text-sm transition-colors',
                  search.source === value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Trend({ rows }: { rows: RunRow[] }) {
  const recent = rows.slice(0, 30).reverse()
  return (
    <div className="flex h-10 items-end gap-[3px]">
      {recent.map((r) => {
        const rate = r.total ? r.passed / r.total : 0
        return (
          <Tooltip key={r.entry.runId}>
            <TooltipTrigger asChild>
              <Link
                to="/runs/$runId"
                params={{ runId: r.entry.runId }}
                className="group flex h-full w-2 flex-col justify-end sm:w-2.5"
              >
                <div
                  className={cn(
                    'w-full rounded-sm transition-opacity group-hover:opacity-70',
                    rate >= 0.999 ? 'bg-pass' : rate === 0 ? 'bg-fail' : 'bg-infra',
                  )}
                  style={{ height: `${Math.max(12, rate * 100)}%` }}
                />
              </Link>
            </TooltipTrigger>
            <TooltipContent>
              {formatPercent(r.total ? rate : null)} · {shortSha(r.entry.git?.sha)} ·{' '}
              {timeAgo(r.entry.startedAt)}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tracking-tight">{children}</div>
    </div>
  )
}

export function RunsPage() {
  const search = route.useSearch()
  const navigate = useNavigate()
  const { data: studio } = useStudio()
  const { data, error, isPending } = useQuery(headersQuery)
  const { runs: live } = useLiveRuns()
  const rows = useMemo(() => (data ? runRows(data.headers) : []), [data])
  const filtered = useMemo(() => {
    const q = search.q?.toLowerCase()
    return rows.filter(({ entry }) => {
      if (search.status === 'failed' && runOutcome(entry) === 'pass') return false
      if (search.status === 'passed' && runOutcome(entry) !== 'pass') return false
      if (search.source === 'recorded' && !entry.recorded) return false
      if (search.source === 'scratch' && entry.recorded) return false
      if (!q) return true
      return [
        entry.runId,
        entry.author,
        entry.git?.branch ?? '',
        entry.git?.sha ?? '',
        entry.ci?.provider ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
  }, [rows, search])

  if (error) return <ErrorState error={error} />
  if (isPending) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <RowsSkeleton rows={8} />
      </div>
    )
  }
  const latest = rows[0]
  const hasScratch = rows.some((r) => !r.entry.recorded)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length
              ? `${plural(rows.length, 'run')} · ${plural(data.manifest.evals.length, 'eval')} tracked`
              : 'Every recorded run of this project, newest first.'}
          </p>
        </div>
        {rows.length > 1 ? <Trend rows={rows} /> : null}
      </div>

      <LiveRuns runs={live.filter((r) => !rows.some((row) => row.entry.runId === r.runId))} />

      {rows.length === 0 && live.length ? null : rows.length === 0 ? (
        <EmptyState icon={History} title="No runs yet">
          Record one with <Code>reeval run --record</Code>, or promote your latest scratch run with{' '}
          <Code>reeval record latest</Code>.{' '}
          {studio?.mode === 'live' ? 'It shows up here as soon as it lands.' : ''}
        </EmptyState>
      ) : (
        <>
          {latest ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Latest run">
                <span className="flex items-center gap-2">
                  <OutcomeIcon outcome={runOutcome(latest.entry)} className="size-5" />
                  {timeAgo(latest.entry.startedAt)}
                </span>
              </Stat>
              <Stat label="Latest pass rate">
                {formatPercent(latest.total ? latest.passed / latest.total : null)}
                <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                  {latest.passed}/{latest.total}
                </span>
              </Stat>
              <Stat label="Failing runs">
                {rows.filter((r) => runOutcome(r.entry) !== 'pass').length}
                <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                  of {rows.length}
                </span>
              </Stat>
              <Stat label="Branches">
                {new Set(rows.map((r) => r.entry.git?.branch ?? '–')).size}
              </Stat>
            </div>
          ) : null}

          <Filters hasScratch={hasScratch} />

          {filtered.length === 0 ? (
            <EmptyState icon={Search} title="No runs match">
              Try a different filter, or clear it to see all {rows.length} runs.
            </EmptyState>
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10" />
                    <TableHead>Run</TableHead>
                    <TableHead>Commit</TableHead>
                    <TableHead className="hidden md:table-cell">Who</TableHead>
                    <TableHead className="w-44">Result</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">Tokens</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Duration</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row) => {
                    const { entry } = row
                    return (
                      <TableRow
                        key={entry.runId}
                        className="cursor-pointer"
                        onClick={() =>
                          navigate({ to: '/runs/$runId', params: { runId: entry.runId } })
                        }
                      >
                        <TableCell className="pl-4">
                          <OutcomeIcon outcome={runOutcome(entry)} />
                        </TableCell>
                        <TableCell>
                          <Link
                            to="/runs/$runId"
                            params={{ runId: entry.runId }}
                            className="font-medium hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span title={formatDate(entry.startedAt)}>
                              {timeAgo(entry.startedAt)}
                            </span>
                          </Link>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {entry.runId}
                            </span>
                            {!entry.recorded ? (
                              <Badge
                                variant="outline"
                                className="h-4 px-1.5 text-[10px] text-muted-foreground"
                              >
                                scratch
                              </Badge>
                            ) : null}
                            {entry.status === 'interrupted' ? (
                              <Badge
                                variant="outline"
                                className="h-4 px-1.5 text-[10px] text-infra"
                              >
                                interrupted
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 font-mono text-xs">
                            {shortSha(entry.git?.sha)}
                            {entry.git?.dirty ? (
                              <span
                                className="size-1.5 rounded-full bg-infra"
                                title="Uncommitted changes"
                              />
                            ) : null}
                          </div>
                          {entry.git?.branch ? (
                            <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                              <GitBranch className="size-3" />
                              <span className="max-w-40 truncate">{entry.git.branch}</span>
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <Who entry={entry} />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="tabular font-medium">
                              {row.passed}/{row.total}
                              <span className="ml-1 font-normal text-muted-foreground">passed</span>
                            </span>
                          </div>
                          <TallyBar
                            className="mt-1.5"
                            pass={entry.summary.pass}
                            fail={entry.summary.fail - entry.summary.notGated}
                            missed={entry.summary.notGated}
                            infra={entry.summary.infraError}
                            skipped={entry.summary.skipped}
                          />
                        </TableCell>
                        <TableCell className="tabular hidden text-right text-muted-foreground lg:table-cell">
                          {formatUsage(entry.usage) ?? '–'}
                        </TableCell>
                        <TableCell className="tabular hidden text-right text-muted-foreground sm:table-cell">
                          {formatDuration(entry.durationMs)}
                        </TableCell>
                        <TableCell className="pr-4 text-right">
                          <DriftBadge changes={row.drift} evals={row.changedEvals} />
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
