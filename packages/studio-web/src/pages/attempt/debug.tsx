import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Download, Globe, ScrollText } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  type AttemptRecord,
  type DebugView,
  formatBytes,
  formatDuration,
  snapshotApiPath,
} from 'reeval/view'
import { EmptyState, ErrorState, RowsSkeleton } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { traceQuery } from '@/lib/data'
import { cn } from '@/lib/utils'

type Segment = { phase: string; start: number; end: number; lines: DebugView['lines'] }

/** Consecutive lines of one phase, as one stretch of the timeline. */
function segments(lines: DebugView['lines']): Segment[] {
  const out: Segment[] = []
  for (const line of lines) {
    const at = Date.parse(line.at)
    const last = out.at(-1)
    if (last && last.phase === line.phase) {
      last.end = at
      last.lines.push(line)
    } else {
      if (last) last.end = Math.max(last.end, at)
      out.push({ phase: line.phase, start: at, end: at, lines: [line] })
    }
  }
  return out
}

function Timeline({ lines }: { lines: DebugView['lines'] }) {
  const parts = useMemo(() => segments(lines), [lines])
  const [open, setOpen] = useState<number | null>(null)
  const first = parts[0]?.start ?? 0
  const total = Math.max(1, (parts.at(-1)?.end ?? first) - first)
  return (
    <div className="space-y-1">
      {parts.map((s, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are ordered and immutable
          key={i}
          className="overflow-hidden rounded-lg border bg-card"
        >
          <button
            type="button"
            onClick={() => setOpen(open === i ? null : i)}
            className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/50"
          >
            <ChevronRight
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform',
                open === i && 'rotate-90',
              )}
            />
            <span className="w-20 shrink-0 font-mono text-xs">{s.phase}</span>
            <span className="tabular w-16 shrink-0 text-right text-xs text-muted-foreground">
              +{formatDuration(s.start - first)}
            </span>
            <div className="relative hidden h-2 flex-1 rounded-full bg-muted sm:block">
              <div
                className="absolute h-2 rounded-full bg-brand"
                style={{
                  left: `${((s.start - first) / total) * 100}%`,
                  width: `${Math.max(0.5, ((s.end - s.start) / total) * 100)}%`,
                }}
              />
            </div>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground sm:hidden">
              {s.lines[0]?.text}
            </span>
            <span className="tabular w-14 shrink-0 text-right text-xs text-muted-foreground">
              {formatDuration(s.end - s.start)}
            </span>
          </button>
          {open === i ? (
            <pre className="max-h-[50vh] overflow-auto border-t bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {s.lines.map((l) => `${l.at.slice(11, 23)}  ${l.text}`).join('\n')}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function Requests({ requests }: { requests: DebugView['requests'] }) {
  if (requests.length === 0) {
    return (
      <EmptyState icon={Globe} title="No gateway requests">
        Nothing went through the egress gateway (the fake sandbox has none).
      </EmptyState>
    )
  }
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-xs">
        <thead className="text-left text-muted-foreground">
          <tr className="border-b">
            <th className="px-3 py-2 font-medium">Request</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Bytes ↑/↓</th>
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Substituted</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: requests are ordered and immutable
            <tr key={i} className="border-b last:border-0 align-top">
              <td className="max-w-[28rem] px-3 py-2 font-mono break-all">
                {r.method} {r.url}
                {!r.allowed && r.reason ? (
                  <div className="mt-0.5 font-sans text-fail">{r.reason}</div>
                ) : null}
              </td>
              <td className="px-3 py-2">
                <Badge
                  variant="outline"
                  className={r.allowed ? 'border-pass/30 text-pass' : 'border-fail/30 text-fail'}
                >
                  {r.allowed ? (r.status ?? '—') : `blocked ${r.status ?? ''}`}
                </Badge>
              </td>
              <td className="tabular px-3 py-2 whitespace-nowrap text-muted-foreground">
                {formatBytes(r.sent)} / {formatBytes(r.received)}
              </td>
              <td className="tabular px-3 py-2 text-muted-foreground">{formatDuration(r.ms)}</td>
              <td className="px-3 py-2 font-mono">{r.substituted.join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Trace({ runId, attemptKey }: { runId: string; attemptKey: string }) {
  const [shown, setShown] = useState(false)
  const [filter, setFilter] = useState('')
  const query = useQuery(traceQuery(runId, attemptKey, shown))
  if (!shown) {
    return (
      <Button variant="outline" size="sm" onClick={() => setShown(true)}>
        <ScrollText /> Load trace.ndjson
      </Button>
    )
  }
  if (query.error) return <ErrorState error={query.error} />
  if (query.isPending) return <RowsSkeleton rows={4} />
  const lines = query.data.split('\n').filter((l) => l && (!filter || l.includes(filter)))
  return (
    <div className="space-y-2">
      <Input
        placeholder="Filter lines, e.g. docker or gateway"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="max-w-sm"
      />
      <pre className="max-h-[60vh] overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
        {lines.join('\n')}
      </pre>
    </div>
  )
}

/** Each snapshot with a download (a directory comes as a tar.gz), or why it wasn't taken. */
function Snapshots({
  runId,
  snapshots,
}: {
  runId: string
  snapshots: NonNullable<AttemptRecord['snapshots']>
}) {
  if (!snapshots.length) {
    return (
      <p className="text-sm text-muted-foreground">
        None: <code className="font-mono">snapshot</code> was off, or the sandbox was gone first.
      </p>
    )
  }
  return (
    <ul className="space-y-2">
      {snapshots.map((s) => (
        <li key={s.name} className="flex flex-wrap items-center gap-3 text-sm">
          {s.path ? (
            <Button asChild variant="outline" size="sm">
              <a href={snapshotApiPath(runId, s.path)} download>
                <Download />
                {s.name}
              </a>
            </Button>
          ) : (
            <span className="font-mono">{s.name}</span>
          )}
          <span className="text-xs text-muted-foreground">
            {s.path ? (
              <>
                {s.files} files, {formatBytes(s.bytes)} ·{' '}
                <code className="font-mono">
                  .reeval/runs/{runId}/{s.path}
                </code>
              </>
            ) : (
              (s.skipped?.message ?? 'not taken')
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The attempt's local debug data: its phase timeline, gateway requests, snapshots and raw trace. */
export function Debug({
  runId,
  attemptKey,
  view,
  snapshots,
}: {
  runId: string
  attemptKey: string
  view: DebugView
  snapshots: AttemptRecord['snapshots']
}) {
  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">
        Local debug data from <code className="font-mono">.reeval/debug</code>. It stays on this
        machine: it isn't recorded, and static builds leave it out.
      </p>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Phase timeline</h3>
        <Timeline lines={view.lines} />
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Network requests</h3>
        <Requests requests={view.requests} />
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Snapshots</h3>
        <Snapshots runId={runId} snapshots={snapshots ?? []} />
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Raw trace</h3>
        {view.trace ? (
          <Trace runId={runId} attemptKey={attemptKey} />
        ) : (
          <p className="text-sm text-muted-foreground">
            No trace.ndjson: it's kept when an attempt fails, or with{' '}
            <code className="font-mono">reeval run --trace</code>.
          </p>
        )}
      </section>
    </div>
  )
}
