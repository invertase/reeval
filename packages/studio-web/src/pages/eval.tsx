import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { ChevronRight, SearchX } from 'lucide-react'
import { useMemo } from 'react'
import { evalHistory, splitEvalId } from 'reeval/view'
import { EvalRunsTable } from '@/components/eval-runs-table'
import { EmptyState, ErrorState, PageHeaderSkeleton, RowsSkeleton } from '@/components/states'
import { OutcomeBadge } from '@/components/status'
import { Button } from '@/components/ui/button'
import { headersQuery, recordQuery } from '@/lib/data'
import { EvalRunBody, RunMeta } from '@/pages/run'

const route = getRouteApi('/evals/$slug')

const RECENT = 4

const fileName = (file: string) => file.split('/').at(-1) ?? file

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
  const entry = record?.evals.find((e) => e.slug === slug)
  const recent = newestFirst.slice(0, RECENT)

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Evals
        </Link>
        <ChevronRight className="size-3.5" />
        <span className="truncate font-mono text-foreground">{fileName(file)}</span>
      </nav>
      <div>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-semibold tracking-tight">{path.at(-1)}</h1>
          {entry ? (
            <OutcomeBadge outcome={entry.outcome} label={entry.todo ? 'Todo' : undefined} />
          ) : null}
        </div>
        {record ? (
          <div className="mt-2">
            <RunMeta record={record} />
          </div>
        ) : null}
      </div>

      {recordPending ? (
        <RowsSkeleton rows={6} />
      ) : record && entry ? (
        <div data-latest-run>
          <EvalRunBody record={record} entry={entry} />
        </div>
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
