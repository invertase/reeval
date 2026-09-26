import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import {
  type CompareStatus,
  type CompareViewRow,
  compareView,
  formatPercent,
  type HistoryEntry,
  shortSha,
} from 'evalsuite/view'
import { ArrowRight, GitCompareArrows, TriangleAlert } from 'lucide-react'
import { useMemo } from 'react'
import { EmptyState, ErrorState, PageHeaderSkeleton, RowsSkeleton } from '@/components/states'
import { OutcomeIcon } from '@/components/status'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { headersQuery, recordQuery } from '@/lib/data'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

const route = getRouteApi('/compare')

const STATUS: Record<CompareStatus, { label: string; className: string }> = {
  regressed: { label: 'Regressed', className: 'border-fail/30 bg-fail/10 text-fail' },
  fixed: { label: 'Fixed', className: 'border-pass/30 bg-pass/10 text-pass' },
  drift: { label: 'Not comparable', className: 'border-drift/30 bg-drift/10 text-drift' },
  infra: { label: 'Infra error', className: 'border-infra/30 bg-infra/10 text-infra' },
  added: { label: 'New', className: 'text-brand border-brand/30' },
  removed: { label: 'Removed', className: 'text-muted-foreground' },
  same: { label: 'Same', className: 'text-muted-foreground' },
}

function RunPicker({
  label,
  value,
  runs,
  onChange,
}: {
  label: string
  value: string | undefined
  runs: HistoryEntry[]
  onChange: (runId: string) => void
}) {
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Choose a run" />
        </SelectTrigger>
        <SelectContent>
          {runs.map((r) => (
            <SelectItem key={r.runId} value={r.runId}>
              <span className="font-mono text-xs">{shortSha(r.git?.sha)}</span>
              <span className="text-muted-foreground">{timeAgo(r.startedAt)}</span>
              <span className="tabular text-xs text-muted-foreground">
                {r.summary.pass}/{r.summary.pass + r.summary.fail + r.summary.infraError}
              </span>
              {!r.recorded ? <span className="text-xs text-muted-foreground">scratch</span> : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function Delta({
  base,
  head,
  kind,
}: {
  base: number | null
  head: number | null
  kind: 'rate' | 'score'
}) {
  const format = kind === 'score' ? formatScore : formatRate
  if (base === null && head === null) return <span className="text-muted-foreground">–</span>
  if (base === null || head === null) {
    return <span className="tabular">{head !== null ? format(head) : format(base as number)}</span>
  }
  const d = head - base
  return (
    <span className="tabular">
      <span className="text-muted-foreground">{format(base)}</span>
      <ArrowRight className="mx-1 inline size-3 text-muted-foreground" />
      {format(head)}
      {Math.abs(d) > 1e-9 ? (
        <span className={cn('ml-1.5 text-xs', d > 0 ? 'text-pass' : 'text-fail')}>
          {d > 0 ? '+' : ''}
          {kind === 'score' ? d.toFixed(2) : `${Math.round(d * 100)} pts`}
        </span>
      ) : null}
    </span>
  )
}

const formatScore = (n: number) => n.toFixed(2)
const formatRate = (n: number) => formatPercent(n)

function Row({ row, head }: { row: CompareViewRow; head: string }) {
  const s = STATUS[row.status]
  const name = row.id.split(' › ').slice(1).join(' › ') || row.id
  return (
    <TableRow className={row.status === 'same' ? 'opacity-70' : undefined}>
      <TableCell className="pl-4">
        <Badge variant="outline" className={s.className}>
          {s.label}
        </Badge>
      </TableCell>
      <TableCell className="max-w-md">
        {row.slug ? (
          <Link
            to="/evals/$slug"
            params={{ slug: row.slug }}
            className="font-medium hover:underline"
          >
            {name}
          </Link>
        ) : (
          name
        )}
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {row.id.split(' › ')[0]}
        </div>
        {row.cells ? (
          <div className="text-[11px] text-muted-foreground">
            compared on the cells both runs have
            {row.cells.added.length ? ` · added ${row.cells.added.join(', ')}` : ''}
            {row.cells.removed.length ? ` · removed ${row.cells.removed.join(', ')}` : ''}
          </div>
        ) : null}
      </TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-1.5">
          <OutcomeIcon outcome={row.base} />
          <ArrowRight className="size-3 text-muted-foreground" />
          {row.slug && row.head ? (
            <Link to="/runs/$runId" params={{ runId: head }} search={{ eval: row.slug }}>
              <OutcomeIcon outcome={row.head} />
            </Link>
          ) : (
            <OutcomeIcon outcome={row.head} />
          )}
        </span>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <Delta base={row.basePassRate} head={row.headPassRate} kind="rate" />
      </TableCell>
      <TableCell className="hidden pr-4 md:table-cell">
        <Delta base={row.baseScore} head={row.headScore} kind="score" />
      </TableCell>
    </TableRow>
  )
}

export function ComparePage() {
  const search = route.useSearch()
  const navigate = useNavigate({ from: '/compare' })
  const { data, error, isPending } = useQuery(headersQuery)
  const headers = data?.headers ?? []
  const head =
    headers.find((h) => h.runId === search.head) ?? (search.head ? undefined : headers[0])
  const base =
    headers.find((h) => h.runId === search.base) ??
    (search.base
      ? undefined
      : headers.find((h) => head && h.runId < head.runId && h.status === 'complete'))
  const baseRecord = useQuery({ ...recordQuery(base?.runId ?? ''), enabled: !!base })
  const headRecord = useQuery({ ...recordQuery(head?.runId ?? ''), enabled: !!head })
  const view = useMemo(
    () =>
      base && head
        ? compareView(base, head, { base: baseRecord.data, head: headRecord.data })
        : null,
    [base, head, baseRecord.data, headRecord.data],
  )

  if (error) return <ErrorState error={error} />
  if (isPending) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <RowsSkeleton rows={6} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Compare runs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What flipped between two runs, with pass-rate and judge-score deltas. Uses the same rules
          as <code className="font-mono text-xs">es compare</code>.
        </p>
      </div>

      {headers.length < 2 ? (
        <EmptyState icon={GitCompareArrows} title="Two runs needed">
          Record at least two runs to compare them.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-end">
            <RunPicker
              label="Base"
              value={base?.runId}
              runs={headers}
              onChange={(v) => navigate({ search: (s) => ({ ...s, base: v }), replace: true })}
            />
            <ArrowRight className="mx-auto hidden size-4 shrink-0 text-muted-foreground sm:mb-2.5 sm:block" />
            <RunPicker
              label="Head"
              value={head?.runId}
              runs={headers}
              onChange={(v) => navigate({ search: (s) => ({ ...s, head: v }), replace: true })}
            />
          </div>

          {!base || !head || !view ? (
            <EmptyState icon={GitCompareArrows} title="Pick two runs">
              Choose a base and a head run to see what changed.
            </EmptyState>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(['regressed', 'fixed', 'drift', 'same'] as const).map((s) => (
                  <div key={s} className="rounded-xl border bg-card px-4 py-3">
                    <div className="text-xs text-muted-foreground">{STATUS[s].label}</div>
                    <div
                      className={cn(
                        'mt-1 text-2xl font-semibold tracking-tight',
                        view.counts[s] && s === 'regressed' && 'text-fail',
                        view.counts[s] && s === 'fixed' && 'text-pass',
                        view.counts[s] && s === 'drift' && 'text-drift',
                      )}
                    >
                      {view.counts[s]}
                    </div>
                  </div>
                ))}
              </div>

              {view.changes.length ? (
                <div className="rounded-xl border border-drift/30 bg-drift/5 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-drift">
                    <TriangleAlert className="size-4" /> The stack changed between these runs
                  </div>
                  <ul className="mt-2 space-y-1 text-sm">
                    {view.changes.map((c) => (
                      <li key={c.field} className="flex flex-wrap items-center gap-x-2">
                        <span className="text-muted-foreground">{c.label}</span>
                        <code className="font-mono text-xs">{c.base}</code>
                        <ArrowRight className="size-3 text-muted-foreground" />
                        <code className="font-mono text-xs">{c.head}</code>
                        {c.outsideFingerprint ? (
                          <span className="text-xs text-muted-foreground">
                            (not in fingerprints: flips count as not comparable)
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="overflow-hidden rounded-xl border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-36 pl-4">Change</TableHead>
                      <TableHead>Eval</TableHead>
                      <TableHead className="w-24">Outcome</TableHead>
                      <TableHead className="hidden md:table-cell">Pass rate</TableHead>
                      <TableHead className="hidden pr-4 md:table-cell">Judge score</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {view.rows.map((row) => (
                      <Row key={row.id} row={row} head={head.runId} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
