import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { evalHistory, formatDuration, hasUngatedCells, shortSha, splitEvalId } from 'evalsuite/view'
import { ChevronRight, GitBranch, SearchX } from 'lucide-react'
import { useMemo } from 'react'
import { EmptyState, ErrorState, PageHeaderSkeleton, RowsSkeleton } from '@/components/states'
import { OutcomeIcon, OutcomeStrip, PassRate, TallyBar } from '@/components/status'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { headersQuery } from '@/lib/data'
import { formatDate, plural, timeAgo } from '@/lib/format'

const route = getRouteApi('/evals/$slug')

export function EvalHistoryPage() {
  const { slug } = route.useParams()
  const { data, error, isPending } = useQuery(headersQuery)
  const points = useMemo(() => (data ? evalHistory(data.headers, slug) : []), [data, slug])

  if (error) return <ErrorState error={error} />
  if (isPending) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <RowsSkeleton rows={8} />
      </div>
    )
  }
  const catalog = data.manifest.evals.find((e) => e.slug === slug)
  if (!catalog || points.length === 0) {
    return (
      <EmptyState icon={SearchX} title="No history for this eval">
        No recorded run includes it. It may have been renamed: evals are keyed by file, group and
        name.
      </EmptyState>
    )
  }
  const { file, path } = splitEvalId(catalog.id)
  const counted = points.filter((p) => p.outcome === 'pass' || p.outcome === 'fail')
  const passes = counted.filter((p) => p.outcome === 'pass').length
  const newestFirst = [...points].reverse()
  const changes = points.filter((p) => p.changed).length

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link to="/evals" className="hover:text-foreground">
          Evals
        </Link>
        <ChevronRight className="size-3.5" />
        <span className="truncate text-foreground">{path.at(-1)}</span>
      </nav>
      <div>
        <div className="font-mono text-xs text-muted-foreground">
          {[file, ...path.slice(0, -1)].join(' › ')}
        </div>
        <h1 className="mt-1.5 text-2xl font-semibold tracking-tight">{path.at(-1)}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Passed in {passes} of {plural(counted.length, 'run')} with a verdict
          {changes ? ` · the eval or its stack changed ${plural(changes, 'time')}` : ''}.
        </p>
      </div>

      <div className="rounded-xl border bg-card p-5">
        <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>Oldest</span>
          <span>
            <span className="mr-1 inline-block h-3 w-px bg-drift align-middle" /> changed
          </span>
          <span>Newest</span>
        </div>
        <OutcomeStrip
          items={points.map((p) => ({
            key: p.run.runId,
            outcome: p.outcome,
            changed: p.changed,
            title: `${shortSha(p.run.git?.sha)} · ${timeAgo(p.run.startedAt)} · ${p.outcome}`,
          }))}
        />
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10" />
              <TableHead>Run</TableHead>
              <TableHead>Commit</TableHead>
              <TableHead className="w-48">Attempts</TableHead>
              <TableHead className="text-right">Pass rate</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Run time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {newestFirst.map((p) => {
              const pass = p.cells.reduce((n, c) => n + c.pass, 0)
              const fail = p.cells.reduce((n, c) => n + c.fail, 0)
              const infra = p.cells.reduce((n, c) => n + c.infraError, 0)
              return (
                <TableRow key={p.run.runId}>
                  <TableCell className="pl-4">
                    <OutcomeIcon outcome={p.outcome} />
                  </TableCell>
                  <TableCell>
                    <Link
                      to="/runs/$runId"
                      params={{ runId: p.run.runId }}
                      search={{ eval: slug }}
                      className="font-medium hover:underline"
                    >
                      <span title={formatDate(p.run.startedAt)}>{timeAgo(p.run.startedAt)}</span>
                    </Link>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {p.run.runId}
                      </span>
                      {p.changed ? (
                        <Badge
                          variant="outline"
                          className="h-4 border-drift/30 px-1.5 text-[10px] text-drift"
                        >
                          changed
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs">{shortSha(p.run.git?.sha)}</span>
                    {p.run.git?.branch ? (
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <GitBranch className="size-3" />
                        {p.run.git.branch}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <span className="tabular text-xs">
                      {pass}/{pass + fail + infra}
                      {p.cells.length > 1 ? (
                        <span className="text-muted-foreground">
                          {' '}
                          · {plural(p.cells.length, 'cell')}
                        </span>
                      ) : null}
                    </span>
                    <TallyBar className="mt-1.5" pass={pass} fail={fail} infra={infra} />
                  </TableCell>
                  <TableCell className="text-right">
                    <PassRate rate={p.passRate} />
                    {hasUngatedCells(p.cells) ? (
                      <span className="ml-1 text-xs text-muted-foreground">gated</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="tabular hidden text-right text-muted-foreground sm:table-cell">
                    {formatDuration(p.run.durationMs)}
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
