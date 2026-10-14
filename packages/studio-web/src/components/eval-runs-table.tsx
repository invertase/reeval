import { Link } from '@tanstack/react-router'
import { GitBranch } from 'lucide-react'
import { type EvalHistoryPoint, formatDuration, hasUngatedCells, shortSha } from 'reeval/view'
import { OutcomeIcon, PassRate, TallyBar } from '@/components/status'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDate, plural, timeAgo } from '@/lib/format'

export function EvalRunsTable({ points, slug }: { points: EvalHistoryPoint[]; slug: string }) {
  return (
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
          {points.map((p) => {
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
  )
}
