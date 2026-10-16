import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  ListChecks,
  TerminalSquare,
} from 'lucide-react'
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

type Assertion = NonNullable<AttemptRecord['assertions']>[number]

const STATUS_ICON = { pass: CircleCheck, fail: CircleX, error: CircleAlert } as const
const STATUS_TONE = { pass: 'text-pass', fail: 'text-fail', error: 'text-infra' } as const

/** Each `expect` the eval made, in call order, with why it failed. */
function Assertions({ assertions }: { assertions: Assertion[] }) {
  return (
    <section className="space-y-2" data-assertions>
      <h3 className="text-sm font-medium">Assertions</h3>
      <div className="divide-y overflow-hidden rounded-lg border bg-card">
        {assertions.map((x) => {
          const Icon = STATUS_ICON[x.status]
          return (
            <div key={x.label} className="space-y-1 px-4 py-2.5">
              <div className="flex items-center gap-3">
                <Icon className={cn('size-4 shrink-0', STATUS_TONE[x.status])} />
                <span className="min-w-0 flex-1 truncate text-sm">{x.label}</span>
                {x.soft ? (
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">
                    soft
                  </Badge>
                ) : null}
                <code className="font-mono text-xs text-muted-foreground">{x.matcher}</code>
                {x.durationMs !== undefined ? (
                  <span className="tabular w-14 text-right text-xs text-muted-foreground">
                    {formatDuration(x.durationMs)}
                  </span>
                ) : null}
              </div>
              {x.message ? (
                <pre className="ml-7 max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">
                  {x.message}
                </pre>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function Checks({ record, attempt }: { record: RunRecord; attempt: AttemptRecord }) {
  const assertions = attempt.assertions ?? []
  if (attempt.checks.length === 0 && assertions.length === 0) {
    return (
      <EmptyState icon={ListChecks} title="No checks">
        This eval made no <code className="font-mono">expect</code> calls and ran no{' '}
        <code className="font-mono">c.exec()</code> commands.
      </EmptyState>
    )
  }
  return (
    <div className="space-y-5">
      {assertions.length ? <Assertions assertions={assertions} /> : null}
      {attempt.checks.length ? (
        <section className="space-y-2">
          {assertions.length ? <h3 className="text-sm font-medium">Commands</h3> : null}
          {attempt.checks.map((check, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: checks are ordered and immutable
            <Check key={i} record={record} check={check} index={i} />
          ))}
        </section>
      ) : null}
    </div>
  )
}
