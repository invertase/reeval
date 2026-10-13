import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { ChevronRight, SearchX } from 'lucide-react'
import { useMemo } from 'react'
import { evalHistory, shortSha, splitEvalId } from 'reeval/view'
import { EvalRunsTable } from '@/components/eval-runs-table'
import { EmptyState, ErrorState, PageHeaderSkeleton, RowsSkeleton } from '@/components/states'
import { OutcomeStrip } from '@/components/status'
import { headersQuery } from '@/lib/data'
import { plural, timeAgo } from '@/lib/format'

const route = getRouteApi('/evals/$slug/history')

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
        <Link to="/" className="hover:text-foreground">
          Evals
        </Link>
        <ChevronRight className="size-3.5" />
        <Link to="/evals/$slug" params={{ slug }} className="truncate hover:text-foreground">
          {path.at(-1)}
        </Link>
        <ChevronRight className="size-3.5" />
        <span className="text-foreground">History</span>
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

      <EvalRunsTable points={newestFirst} slug={slug} />
    </div>
  )
}
