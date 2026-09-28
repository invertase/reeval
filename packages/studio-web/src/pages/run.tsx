import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import {
  ChevronRight,
  Clock,
  Coins,
  FileCode2,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  History,
  ListFilter,
  ShieldAlert,
  User,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  activityLabel,
  type CellRow,
  cellRows,
  type EvalEntry,
  effortSummary,
  evalTree,
  formatDuration,
  formatRatio,
  formatUsage,
  isMatrix,
  isUngatedMiss,
  type RunRecord,
  runOutcome,
  type SandboxWarning,
  shortSha,
  type TreeNode,
  VERDICT_TEXT,
} from 'reeval/view'
import { CopyButton } from '@/components/copy-button'
import { EmptyState, ErrorState, PageHeaderSkeleton, RowsSkeleton } from '@/components/states'
import { Lift, OutcomeBadge, OutcomeIcon, PassRate, TallyBar } from '@/components/status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { headersQuery, recordQuery } from '@/lib/data'
import { formatDate, plural, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { RunAnalysis } from '@/pages/run-analysis'

const route = getRouteApi('/runs/$runId')

function Meta({ icon: Icon, children }: { icon: typeof Clock; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-3.5" />
      {children}
    </span>
  )
}

export function RunHeader({ record, children }: { record: RunRecord; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-semibold tracking-tight">{formatDate(record.startedAt)}</h1>
          <OutcomeBadge outcome={runOutcome(record)} />
          {record.status === 'interrupted' ? (
            <Badge variant="outline" className="text-infra">
              interrupted
            </Badge>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
          <Meta icon={GitCommitHorizontal}>
            <span className="font-mono text-xs">{shortSha(record.git?.sha)}</span>
            {record.git?.dirty ? <span className="text-infra">· dirty</span> : null}
          </Meta>
          {record.git?.branch ? <Meta icon={GitBranch}>{record.git.branch}</Meta> : null}
          <Meta icon={User}>
            {record.runner.kind === 'ci' ? `CI · ${record.runner.provider}` : record.author}
          </Meta>
          <Meta icon={Clock}>{formatDuration(record.durationMs)}</Meta>
          {record.cost.usage ? (
            <Meta icon={Coins}>{formatUsage(record.cost.usage)} tokens</Meta>
          ) : null}
        </div>
      </div>
      {children}
    </div>
  )
}

/** Sandboxes that ran as root or with capabilities added back, one line per level that set them. */
function SandboxWarnings({ warnings }: { warnings: SandboxWarning[] }) {
  if (warnings.length === 0) return null
  const root = warnings.some((w) => w.kind === 'root')
  return (
    <div
      role="alert"
      className={cn(
        'flex gap-3 rounded-xl border p-4 text-sm',
        root ? 'border-fail/40 bg-fail/5' : 'border-infra/40 bg-infra/5',
      )}
    >
      <ShieldAlert className={cn('mt-0.5 size-4 shrink-0', root ? 'text-fail' : 'text-infra')} />
      <ul className="min-w-0 space-y-1">
        {warnings.map((w) => (
          <li key={`${w.file}\0${w.message}`} className="break-words">
            <span className={cn('font-semibold', w.kind === 'root' ? 'text-fail' : 'text-infra')}>
              {w.kind === 'root' ? 'Root' : 'Capabilities'}
            </span>{' '}
            <span className="font-mono text-xs">{w.message}</span>
            {w.file ? <span className="text-muted-foreground"> · {w.file}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function TreeRow({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode
  depth: number
  selected?: string
  onSelect: (slug: string) => void
}) {
  const [open, setOpen] = useState(true)
  const pad = { paddingLeft: `${depth * 14 + 8}px` }
  if (node.kind === 'eval') {
    const active = selected === node.eval.slug
    return (
      <button
        type="button"
        onClick={() => onSelect(node.eval.slug)}
        style={pad}
        className={cn(
          'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors',
          active ? 'bg-accent text-foreground' : 'text-foreground/85 hover:bg-accent/60',
        )}
      >
        <OutcomeIcon outcome={node.eval.outcome} />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {node.eval.todo ? (
          <span className="shrink-0 text-xs text-muted-foreground">todo</span>
        ) : isMatrix(node.eval) ? (
          <span className="tabular shrink-0 text-xs text-muted-foreground">
            {node.tally.pass}/
            {node.tally.pass + node.tally.fail + node.tally.missed + node.tally.infra}
          </span>
        ) : null}
      </button>
    )
  }
  const isFile = depth === 0
  const Icon = isFile ? FileCode2 : Folder
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={pad}
        className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent/60"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        <Icon className="size-3.5" />
        <span className={cn('min-w-0 flex-1 truncate', isFile && 'font-mono')}>{node.name}</span>
        {node.tally.fail ? (
          <span className="tabular text-fail">{node.tally.fail} failed</span>
        ) : node.tally.missed ? (
          <span className="tabular">{node.tally.missed} missed, not gated</span>
        ) : null}
      </button>
      {open
        ? node.children.map((child) => (
            <TreeRow
              key={child.key}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))
        : null}
    </div>
  )
}

function pruneFailed(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((n): TreeNode[] => {
    if (n.kind === 'eval')
      return n.eval.outcome === 'pass' || n.eval.outcome === 'skipped' ? [] : [n]
    const children = pruneFailed(n.children)
    return children.length ? [{ ...n, children }] : []
  })
}

function CellsTable({ rows, runId, slug }: { rows: CellRow[]; runId: string; slug: string }) {
  const showLift = rows.some((r) => r.lift !== null)
  const showEffort = rows.some((r) => r.effort !== null)
  const compare = rows.some((r) => r.role === 'variant')
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Harness</TableHead>
            <TableHead>Environment</TableHead>
            {compare ? <TableHead>Role</TableHead> : null}
            <TableHead className="hidden 2xl:table-cell">Sandbox</TableHead>
            <TableHead>Attempts</TableHead>
            <TableHead className="text-right">Pass rate</TableHead>
            {showLift || showEffort ? (
              <TableHead className="text-right">
                {showLift && showEffort ? 'Lift and effort' : showLift ? 'Lift' : 'Effort'}
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key} className="hover:bg-transparent">
              <TableCell className="font-mono text-xs">{row.harness}</TableCell>
              <TableCell className="font-mono text-xs">
                {row.environment === '-' ? (
                  <span className="text-muted-foreground">none</span>
                ) : (
                  row.environment
                )}
                {row.overrides.length ? (
                  <div className="mt-0.5 font-sans text-[11px] text-muted-foreground">
                    overrides {row.overrides.join(', ')}
                  </div>
                ) : null}
              </TableCell>
              {compare ? (
                <TableCell>
                  <div className="flex items-center gap-1.5 text-xs">
                    {row.role}
                    {row.gated ? null : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">
                        not gated
                      </Badge>
                    )}
                  </div>
                </TableCell>
              ) : null}
              <TableCell className="hidden font-mono text-xs 2xl:table-cell">
                {row.sandbox}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  {row.attempts.map((a) => (
                    <Link
                      key={a.id}
                      to="/runs/$runId/evals/$slug/attempts/$attempt"
                      params={{ runId, slug, attempt: a.id }}
                      title={`${a.id} · ${formatDuration(a.durationMs)}`}
                      className="rounded-sm p-0.5 hover:bg-accent"
                    >
                      <OutcomeIcon outcome={a.outcome} missed={!row.gated} />
                    </Link>
                  ))}
                </div>
              </TableCell>
              <TableCell className="text-right">
                <PassRate rate={row.passRate} />
                <span className="tabular ml-1.5 text-xs text-muted-foreground">
                  {row.pass}/{row.pass + row.fail}
                </span>
              </TableCell>
              {showLift || showEffort ? (
                <TableCell className="min-w-44 whitespace-normal text-right">
                  {showLift ? <Lift points={row.lift} interval={row.liftInterval} /> : null}
                  {row.belowMinLift ? (
                    <div className="text-[11px] text-fail">lower bound below minLift</div>
                  ) : null}
                  {showEffort ? (
                    <div className={showLift ? 'mt-1' : undefined}>
                      <Effort row={row} />
                    </div>
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** Median tool calls and agent time; for a variant, against its control with the test's verdict. */
function Effort({ row }: { row: CellRow }) {
  if (!row.effort) return <span className="text-muted-foreground">–</span>
  const vs = row.effortVsControl
  const effect = vs && (vs.verdict === 'fewer' || vs.verdict === 'more')
  return (
    <div className="tabular text-xs">
      <div>{effortSummary(row.effort)}</div>
      {vs ? (
        <div
          className={cn(
            'text-[11px]',
            effect ? (vs.verdict === 'fewer' ? 'text-pass' : 'text-fail') : 'text-muted-foreground',
          )}
          title={vs.toolsP !== null ? `exact rank test p = ${vs.toolsP.toFixed(3)}` : undefined}
        >
          tools {formatRatio(vs.toolsRatio)} vs control · {VERDICT_TEXT[vs.verdict]('tool calls')}
        </div>
      ) : null}
    </div>
  )
}

function EvalPanel({ record, entry }: { record: RunRecord; entry: EvalEntry }) {
  const rows = cellRows(entry)
  const matrix = isMatrix(entry)
  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
          {[entry.file, ...entry.group].join(' › ')}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
          <h2 className="text-lg font-semibold tracking-tight">{entry.name}</h2>
          <OutcomeBadge outcome={entry.outcome} label={entry.todo ? 'Todo' : undefined} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/evals/$slug" params={{ slug: entry.slug }}>
              <History /> History
            </Link>
          </Button>
          {entry.tags.map((t) => (
            <Badge key={t} variant="secondary">
              #{t}
            </Badge>
          ))}
        </div>
      </div>

      {matrix ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Cells</h3>
          <CellsTable rows={rows} runId={record.runId} slug={entry.slug} />
        </section>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{plural(entry.attempts.length, 'attempt')}</h3>
        <div className="divide-y overflow-hidden rounded-lg border">
          {entry.attempts.map((a) => {
            const judge = a.judgements[0]
            const missed = isUngatedMiss(entry, a)
            return (
              <Link
                key={a.id}
                to="/runs/$runId/evals/$slug/attempts/$attempt"
                params={{ runId: record.runId, slug: entry.slug, attempt: a.id }}
                className="group flex items-start gap-3 px-3.5 py-3 transition-colors hover:bg-accent/50"
              >
                <OutcomeIcon outcome={a.outcome} missed={missed} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="font-mono text-xs">{a.id}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDuration(a.durationMs)} · {plural(a.turns.length, 'turn')} ·{' '}
                      {activityLabel(a.activity)}
                    </span>
                    {judge ? (
                      <span
                        className={cn(
                          'tabular text-xs',
                          judge.verdict === 'pass' ? 'text-pass' : 'text-fail',
                        )}
                      >
                        judge {judge.score.toFixed(2)} / {judge.threshold}
                      </span>
                    ) : null}
                    {missed ? (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">
                        missed, not gated
                      </Badge>
                    ) : null}
                  </div>
                  {a.error ? (
                    <p
                      className={cn(
                        'mt-1 line-clamp-2 font-mono text-xs',
                        missed ? 'text-muted-foreground' : 'text-fail',
                      )}
                    >
                      {a.error.kind}: {a.error.message.split('\n')[0]}
                    </p>
                  ) : a.turns.at(-1)?.text ? (
                    <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                      {a.turns.at(-1)?.text}
                    </p>
                  ) : null}
                </div>
                <ChevronRight className="mt-0.5 size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>
            )
          })}
        </div>
      </section>
    </div>
  )
}

export function RunPage() {
  const { runId } = route.useParams()
  const search = route.useSearch()
  const navigate = useNavigate({ from: '/runs/$runId' })
  const { data: record, error, isPending } = useQuery(recordQuery(runId))
  const { data: index } = useQuery(headersQuery)
  const tree = useMemo(() => (record ? evalTree(record) : []), [record])

  if (error) return <ErrorState error={error} />
  if (isPending) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <RowsSkeleton rows={8} />
          <RowsSkeleton rows={4} />
        </div>
      </div>
    )
  }

  const shown = search.show === 'failed' ? pruneFailed(tree) : tree
  const selected =
    record.evals.find((e) => e.slug === search.eval) ??
    record.evals.find((e) => e.outcome === 'fail' || e.outcome === 'infra_error') ??
    record.evals[0]
  const headers = index?.headers ?? []
  const previous = headers.find((h) => h.runId < runId && h.status === 'complete')
  const { pass, fail: failed, notGated, infraError, skipped } = record.summary
  const fail = failed - notGated

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Runs
        </Link>
        <ChevronRight className="size-3.5" />
        <span className="truncate font-mono text-xs text-foreground">{runId}</span>
      </nav>

      <RunHeader record={record}>
        <div className="flex flex-wrap gap-2">
          {previous ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/compare" search={{ base: previous.runId, head: runId }}>
                <GitCompareArrows /> Compare with previous
              </Link>
            </Button>
          ) : null}
          {record.git ? (
            <CopyButton value={`reeval checkout ${runId}`} label="reeval checkout" />
          ) : null}
        </div>
      </RunHeader>

      <SandboxWarnings warnings={record.plan.sandboxWarnings} />

      <div className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>
            <span className="font-semibold">{pass}</span> passed
            {fail ? (
              <>
                {' · '}
                <span className="font-semibold text-fail">{fail}</span> failed
              </>
            ) : null}
            {notGated ? (
              <>
                {' · '}
                <span className="font-semibold">{notGated}</span> missed, not gated
              </>
            ) : null}
            {infraError ? (
              <>
                {' · '}
                <span className="font-semibold text-infra">{infraError}</span> infra errors
              </>
            ) : null}
            {skipped ? ` · ${skipped} skipped` : ''}
            <span className="text-muted-foreground">
              {' '}
              across {plural(record.summary.evals, 'eval')},{' '}
              {plural(record.summary.attempts, 'attempt')}
            </span>
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {record.stack.harnesses.map((h) => h.id).join(', ')} · judge{' '}
            {record.config.judgeModel ?? 'none'}
            {record.profile ? ` · profile ${record.profile.name}` : ''}
          </span>
        </div>
        <TallyBar
          className="mt-3 h-2"
          pass={pass}
          fail={fail}
          missed={notGated}
          infra={infraError}
          skipped={skipped}
        />
      </div>

      <Tabs
        value={search.tab ?? 'evals'}
        onValueChange={(tab) =>
          navigate({
            search: (s) => ({ ...s, tab: tab === 'analysis' ? 'analysis' : undefined }),
            replace: true,
          })
        }
      >
        <TabsList>
          <TabsTrigger value="evals">Evals</TabsTrigger>
          <TabsTrigger value="analysis">Analysis</TabsTrigger>
        </TabsList>
        <TabsContent value="evals" className="mt-4">
          {record.evals.length === 0 ? (
            <EmptyState icon={ListFilter} title="No evals ran">
              This run matched no evals, so there's nothing to show.
            </EmptyState>
          ) : (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
              <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start">
                <div className="rounded-xl border bg-card">
                  <div className="flex items-center justify-between border-b px-3 py-2">
                    <span className="text-sm font-medium">Evals</span>
                    <div className="inline-flex rounded-md bg-muted p-0.5 text-xs">
                      {(
                        [
                          [undefined, 'All'],
                          ['failed', 'Failing'],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() =>
                            navigate({ search: (s) => ({ ...s, show: value }), replace: true })
                          }
                          className={cn(
                            'rounded px-2 py-0.5',
                            search.show === value
                              ? 'bg-background shadow-sm'
                              : 'text-muted-foreground',
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="max-h-[60vh] overflow-y-auto p-1.5 lg:max-h-[calc(100dvh-14rem)]">
                    {shown.length === 0 ? (
                      <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                        Nothing failed in this run.
                      </p>
                    ) : (
                      shown.map((node) => (
                        <TreeRow
                          key={node.key}
                          node={node}
                          depth={0}
                          selected={selected?.slug}
                          onSelect={(slug) =>
                            navigate({ search: (s) => ({ ...s, eval: slug }), replace: true })
                          }
                        />
                      ))
                    )}
                  </div>
                </div>
              </aside>
              <section className="min-w-0 rounded-xl border bg-card p-5">
                {selected ? <EvalPanel record={record} entry={selected} /> : null}
              </section>
            </div>
          )}
        </TabsContent>
        <TabsContent value="analysis" className="mt-4">
          <section className="rounded-xl border bg-card p-5">
            <RunAnalysis runId={runId} />
          </section>
        </TabsContent>
      </Tabs>
      <p className="text-xs text-muted-foreground">
        Started {timeAgo(record.startedAt)} · artifacts: {record.artifacts} · reeval{' '}
        {record.stack.es}
      </p>
    </div>
  )
}
