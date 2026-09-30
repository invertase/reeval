import { ChevronRight, ListChecks, TerminalSquare } from 'lucide-react'
import { useState } from 'react'
import { type AttemptRecord, formatDuration, type RunRecord } from 'reeval/view'
import { Artifact } from '@/components/artifact'
import { EmptyState } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

function Check({
  record,
  check,
  index,
}: {
  record: RunRecord
  check: AttemptRecord['checks'][number]
  index: number
}) {
  const ok = check.exitCode === 0
  const [open, setOpen] = useState(!ok)
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/50"
      >
        <ChevronRight
          className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <TerminalSquare className="size-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">#{index + 1}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-sm">{check.command}</code>
        <Badge
          variant="outline"
          className={ok ? 'border-pass/30 text-pass' : 'border-fail/30 text-fail'}
        >
          exit {check.exitCode}
        </Badge>
        <span className="tabular w-14 text-right text-xs text-muted-foreground">
          {formatDuration(check.durationMs)}
        </span>
      </button>
      {open ? (
        <div className="border-t bg-muted/30 p-3">
          <Artifact record={record} file={check.log} what="log">
            {(text) => (
              <pre className="max-h-[60vh] overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">
                {text}
              </pre>
            )}
          </Artifact>
        </div>
      ) : null}
    </div>
  )
}

export function Checks({ record, attempt }: { record: RunRecord; attempt: AttemptRecord }) {
  if (attempt.checks.length === 0) {
    return (
      <EmptyState icon={ListChecks} title="No checks">
        This eval ran no <code className="font-mono">c.exec()</code> commands.
      </EmptyState>
    )
  }
  return (
    <div className="space-y-2">
      {attempt.checks.map((check, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: checks are ordered and immutable
        <Check key={i} record={record} check={check} index={i} />
      ))}
    </div>
  )
}
