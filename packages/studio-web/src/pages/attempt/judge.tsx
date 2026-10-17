import { Gavel } from 'lucide-react'
import type { AttemptRecord, JudgementRecord, RunRecord } from 'reeval/view'
import { Artifact } from '@/components/artifact'
import { EmptyState } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type JudgeInput = {
  question: string
  model: string
  sees?: Record<string, unknown>
  state: Record<string, unknown>
}

const seen = (value: unknown) =>
  value === true ? null : Array.isArray(value) ? value.join(', ') : String(value)

/** `task · output · diff (src/) · transcript (tools)`, then the keys that are off. */
function Sees({ sees }: { sees: Record<string, unknown> }) {
  const entries = Object.entries(sees)
  const on = entries.filter(
    ([k, v]) =>
      v !== false && !(Array.isArray(v) && v.length === 0) && !(k === 'turns' && v === 'last'),
  )
  const off = entries.filter(([, v]) => v === false || (Array.isArray(v) && v.length === 0))
  return (
    <div className="border-b px-4 py-2 text-xs">
      <span className="mr-2 text-muted-foreground">Sees</span>
      <span className="font-mono">
        {on.map(([k, v]) => (seen(v) === null ? k : `${k} (${seen(v)})`)).join(' · ')}
      </span>
      {off.length ? (
        <span className="ml-3 font-mono text-muted-foreground">
          off: {off.map(([k]) => k).join(', ')}
        </span>
      ) : null}
    </div>
  )
}

function ScoreBar({ score, threshold, pass }: { score: number; threshold: number; pass: boolean }) {
  return (
    <div className="relative h-2 rounded-full bg-muted">
      <div
        className={cn('absolute inset-y-0 left-0 rounded-full', pass ? 'bg-pass' : 'bg-fail')}
        style={{ width: `${Math.max(2, score * 100)}%` }}
      />
      <div
        className="absolute -top-1 -bottom-1 w-0.5 rounded bg-foreground"
        style={{ left: `${threshold * 100}%` }}
        title={`threshold ${threshold}`}
      />
    </div>
  )
}

function Verdict({ j }: { j: JudgementRecord }) {
  const pass = j.verdict === 'pass'
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium leading-relaxed">{j.question}</p>
        <Badge
          variant="outline"
          className={pass ? 'border-pass/30 text-pass' : 'border-fail/30 text-fail'}
        >
          {j.verdict}
        </Badge>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-center">
        <ScoreBar score={j.score} threshold={j.threshold} pass={pass} />
        <div className="tabular text-sm">
          <span className="font-semibold">{j.score.toFixed(2)}</span>
          <span className="text-muted-foreground"> / threshold {j.threshold}</span>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Model</dt>
        <dd className="font-mono">{j.model}</dd>
        {j.resolvedModel && j.resolvedModel !== j.model ? (
          <>
            <dt className="text-muted-foreground">Served by</dt>
            <dd className="font-mono">{j.resolvedModel}</dd>
          </>
        ) : null}
      </dl>
    </div>
  )
}

function Field({ name, value }: { name: string; value: unknown }) {
  const ref =
    value && typeof value === 'object' && '$ref' in (value as Record<string, unknown>)
      ? String((value as Record<string, unknown>).$ref)
      : null
  return (
    <div className="border-b px-4 py-3 last:border-b-0">
      <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {name}
      </div>
      {ref ? (
        <p className="text-sm text-muted-foreground">
          The judge saw <code className="font-mono text-foreground">{ref}</code> (see the Diff tab).
        </p>
      ) : Array.isArray(value) ? (
        <ul className="space-y-0.5 font-mono text-xs">
          {value.map((v) => (
            <li key={String(v)}>{typeof v === 'string' ? v : JSON.stringify(v)}</li>
          ))}
        </ul>
      ) : (
        <pre className="max-h-72 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  )
}

export function Judge({ record, attempt }: { record: RunRecord; attempt: AttemptRecord }) {
  if (attempt.judgements.length === 0 && !attempt.files.judgeInput) {
    return (
      <EmptyState icon={Gavel} title="No judge">
        This eval made no <code className="font-mono">c.judge()</code> calls.
      </EmptyState>
    )
  }
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        {attempt.judgements.map((j) => (
          <Verdict key={j.question} j={j} />
        ))}
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">What the judge saw</h3>
        <Artifact record={record} file={attempt.files.judgeInput} what="judge input">
          {(text) => {
            let inputs: JudgeInput[] = []
            try {
              inputs = JSON.parse(text) as JudgeInput[]
            } catch {
              return <pre className="font-mono text-xs whitespace-pre-wrap">{text}</pre>
            }
            return (
              <div className="space-y-3">
                {inputs.map((input) => (
                  <div key={input.question} className="overflow-hidden rounded-lg border bg-card">
                    <div className="border-b bg-muted/40 px-4 py-2 text-xs">
                      <span className="font-medium">{input.question}</span>
                      <span className="ml-2 font-mono text-muted-foreground">{input.model}</span>
                    </div>
                    {input.sees ? <Sees sees={input.sees} /> : null}
                    {Object.entries(input.state).map(([k, v]) => (
                      <Field key={k} name={k} value={v} />
                    ))}
                  </div>
                ))}
              </div>
            )
          }}
        </Artifact>
      </section>
    </div>
  )
}
