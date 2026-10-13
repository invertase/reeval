import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { ChevronRight, SearchX } from 'lucide-react'
import { useMemo } from 'react'
import { cellRows, evalHistory, splitEvalId } from 'reeval/view'
import { EvalRunsTable } from '@/components/eval-runs-table'
import { EmptyState, ErrorState, PageHeaderSkeleton, RowsSkeleton } from '@/components/states'
import { Button } from '@/components/ui/button'
import { headersQuery, recordQuery } from '@/lib/data'
import { plural, timeAgo } from '@/lib/format'
import { CellsTable } from '@/pages/run'

const route = getRouteApi('/evals/$slug')

const RECENT = 4

export function EvalPage() {
  const { slug } = route.useParams()
  const { data, error, isPending } = useQuery(headersQuery)
  const points = useMemo(() => (data ? evalHistory(data.headers, slug) : []), [data, slug])
  const newestFirst = useMemo(() => [...points].reverse(), [points])
  const latest = newestFirst[0]
  const { data: record, isPending: recordPending } = useQuery({
    ...recordQuery(latest?.run.runId ?? ''),
    enabled: !!latest,
  })

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
  if (!catalog || points.length === 0 || !latest) {
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
  const changes = points.filter((p) => p.changed).length
  const entry = record?.evals.find((e) => e.slug === slug)
  const rows = entry ? cellRows(entry) : []
  const recent = newestFirst.slice(0, RECENT)

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
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

      {recordPending ? (
        <RowsSkeleton rows={4} />
      ) : entry && rows.length ? (
        <section className="space-y-3" data-latest-run>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium">Latest run</h2>
            <Link
              to="/runs/$runId"
              params={{ runId: latest.run.runId }}
              search={{ eval: slug }}
              className="text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              {timeAgo(latest.run.startedAt)}
            </Link>
          </div>
          <CellsTable rows={rows} runId={latest.run.runId} slug={slug} />
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Run history</h2>
          {points.length > RECENT ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/evals/$slug/history" params={{ slug }}>
                View All
              </Link>
            </Button>
          ) : null}
        </div>
        <EvalRunsTable points={recent} slug={slug} />
      </section>
    </div>
  )
}
