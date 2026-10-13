import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { FlaskConical, Search } from 'lucide-react'
import { useMemo } from 'react'
import { type EvalCatalogEntry, evalHistory } from 'reeval/view'
import { EmptyState, ErrorState, PageHeaderSkeleton, RowsSkeleton } from '@/components/states'
import { OutcomeIcon, OutcomeStrip, PassRate } from '@/components/status'
import { Input } from '@/components/ui/input'
import { headersQuery } from '@/lib/data'
import { plural } from '@/lib/format'

const route = getRouteApi('/')

export function EvalsPage() {
  const { q } = route.useSearch()
  const navigate = useNavigate({ from: '/' })
  const { data, error, isPending } = useQuery(headersQuery)
  const byFile = useMemo(() => {
    const groups = new Map<string, EvalCatalogEntry[]>()
    const needle = q?.toLowerCase()
    for (const e of data?.manifest.evals ?? []) {
      if (needle && !e.id.toLowerCase().includes(needle)) continue
      const list = groups.get(e.file) ?? []
      list.push(e)
      groups.set(e.file, list)
    }
    return [...groups]
  }, [data, q])

  if (error) return <ErrorState error={error} />
  if (isPending) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <RowsSkeleton rows={8} />
      </div>
    )
  }
  const recent = data.headers.slice(0, 20)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Evals</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {plural(data.manifest.evals.length, 'eval')} across {plural(data.headers.length, 'run')}
            . The strip shows the last 20 runs, oldest to newest.
          </p>
        </div>
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q ?? ''}
            onChange={(e) =>
              navigate({ search: { q: e.target.value || undefined }, replace: true })
            }
            placeholder="Filter evals"
            className="h-9 pl-8"
          />
        </div>
      </div>
      {data.manifest.evals.length === 0 ? (
        <EmptyState icon={FlaskConical} title="No evals yet">
          Evals appear here once a run that includes them is recorded.
        </EmptyState>
      ) : byFile.length === 0 ? (
        <EmptyState icon={Search} title="No evals match">
          Nothing matches “{q}”.
        </EmptyState>
      ) : (
        byFile.map(([file, evals]) => (
          <section key={file} className="overflow-hidden rounded-xl border bg-card">
            <div className="border-b bg-muted/40 px-4 py-2 font-mono text-xs text-muted-foreground">
              {file}
            </div>
            <div className="divide-y">
              {evals.map((e) => {
                const points = evalHistory(recent, e.slug)
                const counted = points.filter((p) => p.outcome === 'pass' || p.outcome === 'fail')
                const rate = counted.length
                  ? counted.filter((p) => p.outcome === 'pass').length / counted.length
                  : null
                return (
                  <Link
                    key={e.slug}
                    to="/evals/$slug"
                    params={{ slug: e.slug }}
                    className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-accent/50 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <OutcomeIcon outcome={e.latest.outcome} />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{e.path.at(-1)}</div>
                        {e.path.length > 1 ? (
                          <div className="truncate text-xs text-muted-foreground">
                            {e.path.slice(0, -1).join(' › ')}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 pl-6 sm:pl-0">
                      <OutcomeStrip
                        size="sm"
                        items={recent
                          .slice()
                          .reverse()
                          .map((run) => ({
                            key: run.runId,
                            outcome: run.evals.find((x) => x.slug === e.slug)?.outcome ?? null,
                          }))}
                      />
                      <PassRate rate={rate} className="w-10 text-right text-sm" />
                    </div>
                  </Link>
                )
              })}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
