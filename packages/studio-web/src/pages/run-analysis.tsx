import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import {
  type AnalysisClaim,
  type AnalysisDoc,
  type AnalysisEntry,
  type AnalysisNote,
  isSuperseded,
} from 'reeval/view'
import { CopyButton } from '@/components/copy-button'
import { EmptyState, ErrorState, RowsSkeleton } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { analysisQuery } from '@/lib/data'
import { formatDate } from '@/lib/format'

/** A citation: an attempt links to its page; a fact or evidence id shows what it says. */
function Cite({ doc, id }: { doc: AnalysisDoc; id: string }) {
  const attempt = doc.attempts[id.replace(/:exec\d+$/, '')]
  const chip =
    'inline-flex rounded border bg-muted/60 px-1 font-mono text-[10px] text-muted-foreground'
  if (attempt) {
    return (
      <Link
        to="/runs/$runId/evals/$slug/attempts/$attempt"
        params={{ runId: attempt.runId, slug: attempt.evalSlug, attempt: attempt.attempt }}
        className={`${chip} hover:text-foreground`}
      >
        {id}
      </Link>
    )
  }
  return (
    <span className={chip} title={doc.cited[id] ?? id}>
      {id}
    </span>
  )
}

function Cites({ doc, ids }: { doc: AnalysisDoc; ids: string[] }) {
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {ids.map((id) => (
        <Cite key={id} doc={doc} id={id} />
      ))}
    </span>
  )
}

function Claims({
  doc,
  title,
  items,
}: {
  doc: AnalysisDoc
  title: string
  items: AnalysisClaim[]
}) {
  if (!items.length) return null
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="list-disc space-y-1.5 pl-5 text-sm">
        {items.map((c) => (
          <li key={c.text}>
            {c.text}
            <Cites doc={doc} ids={c.cites} />
            {c.confidence !== 'high' ? (
              <span className="ml-1 text-xs text-muted-foreground">
                ({c.confidence} confidence)
              </span>
            ) : null}
            {c.unverifiedNumbers?.length ? (
              <span className="ml-1 text-xs text-infra">
                (not in the cited facts: {c.unverifiedNumbers.join(', ')})
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** A model call that failed, in place of what it would have written. */
function Failed({ what, error, children }: { what: string; error: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-fail/40 bg-fail/5 p-3 text-sm">
      <p>
        <span className="font-medium text-fail">{what} failed: </span>
        <span className="break-words">{error}</span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        The run's outcomes don't change.{children ? ' ' : ''}
        {children}
      </p>
    </div>
  )
}

function AnalysisView({ entry }: { entry: AnalysisEntry }) {
  const { doc } = entry
  const a = doc.analysis
  const v = doc.validation
  const source = (
    <Badge variant={entry.source === 'saved' ? 'secondary' : 'outline'}>
      {entry.source === 'saved' ? 'saved' : 'local cache'}
    </Badge>
  )
  if (doc.error !== undefined) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {source}
          <span>
            {doc.model} · {formatDate(doc.createdAt)}
          </span>
        </div>
        <Failed what="The run's summary" error={doc.error}>
          <code className="font-mono">reeval analyze {doc.anchor}</code> calls the model again.
        </Failed>
      </div>
    )
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {source}
        {isSuperseded(doc) ? (
          <Badge variant="outline" className="text-infra">
            superseded: re-run reeval analyze
          </Badge>
        ) : null}
        <span>
          {doc.scope.base ? `vs ${doc.scope.base}` : 'no base run'}
          {doc.scope.evals ? ` · evals matching "${doc.scope.evals}"` : ''} · by {doc.author} ·{' '}
          {formatDate(doc.createdAt)}
        </span>
      </div>
      <p className="rounded-lg border bg-muted/40 p-3 text-sm leading-relaxed">
        <span className="font-semibold">TL;DR ({a.confidence.overall}). </span>
        {a.tldr}
      </p>
      <Claims doc={doc} title="What happened" items={a.whatHappened} />
      <Claims doc={doc} title="Results" items={a.results} />
      <Claims doc={doc} title="Why" items={a.why} />
      {a.anomalies.length ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Anomalies</h3>
          <ul className="space-y-1.5 text-sm">
            {a.anomalies.map((x) => (
              <li key={x.text}>
                <Badge variant="outline" className="mr-1.5 text-[10px]">
                  {x.kind}
                </Badge>
                {x.text}
                <Cites doc={doc} ids={x.cites} />
                {x.unverifiedNumbers?.length ? (
                  <span className="ml-1 text-xs text-infra">
                    (not in the cited facts: {x.unverifiedNumbers.join(', ')})
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Suggested actions</h3>
        {a.actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">None: nothing here is worth acting on.</p>
        ) : (
          <ol className="space-y-3">
            {a.actions.map((x, i) => (
              <li key={x.title} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {i + 1}. {x.title}
                  </span>
                  <Badge variant="secondary" className="text-[10px]">
                    {x.kind}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    impact {x.impact} · effort {x.effort}
                  </span>
                </div>
                <p className="mt-1.5">
                  <code className="font-mono text-xs">{x.target}</code>: {x.change}
                </p>
                <p className="mt-1 text-muted-foreground">Expect: {x.expectedEffect}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                  {x.verify ? (
                    <>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{x.verify}</code>
                      <CopyButton value={x.verify} label="copy" />
                    </>
                  ) : (
                    <span className="text-infra">
                      Verify command rejected: {x.verifyProblem ?? 'not reeval’s CLI'}
                    </span>
                  )}
                  <Cites doc={doc} ids={x.cites} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
      <p className="text-sm">
        <span className="font-medium">Confidence: {a.confidence.overall}.</span> {a.confidence.why}
      </p>
      <p className="text-xs text-muted-foreground">
        {doc.resolvedModel ?? doc.model} · {doc.promptVersion} · digest v{doc.inputs.digestVersion}
        {doc.usage.inputTokens !== null
          ? ` · ${doc.usage.inputTokens} in / ${doc.usage.outputTokens ?? '?'} out tokens`
          : ''}{' '}
        · {v.citations} citations checked, {v.invalid.length} invalid, {v.dropped} dropped ·{' '}
        {v.commands} commands checked, {v.invalidCommands.length} rejected · {entry.file}
      </p>
    </div>
  )
}

/** `analysis.agent`'s notes, by eval, one per harness. */
function Notes({ notes }: { notes: AnalysisNote[] }) {
  const evals = [...new Set(notes.map((n) => n.evalId))]
  return (
    <section className="space-y-3" aria-label="Notes by harness">
      <h3 className="text-sm font-medium">Notes by harness</h3>
      {evals.map((evalId) => (
        <div key={evalId} className="space-y-2">
          <p className="font-mono text-xs text-muted-foreground">{evalId}</p>
          <ul className="space-y-2">
            {notes
              .filter((n) => n.evalId === evalId)
              .map((n) => (
                <li key={n.harness} className="rounded-lg border p-3 text-sm">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="secondary">{n.harness}</Badge>
                    <span>
                      {n.attempts.length} attempt{n.attempts.length === 1 ? '' : 's'} ·{' '}
                      {n.resolvedModel ?? n.model}
                    </span>
                  </div>
                  {n.error !== undefined ? (
                    <Failed what="This note" error={n.error} />
                  ) : (
                    <p className="whitespace-pre-wrap leading-relaxed">{n.text}</p>
                  )}
                </li>
              ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

/** The run's saved analyses, and in `reeval studio` the locally cached ones and notes; read-only. */
export function RunAnalysis({ runId }: { runId: string }) {
  const { data, error, isPending } = useQuery(analysisQuery(runId))
  const [picked, setPicked] = useState<string | undefined>()
  if (error) return <ErrorState error={error} />
  if (isPending) return <RowsSkeleton rows={5} />
  const entries = data?.entries ?? []
  const notes = data?.notes ?? []
  if (entries.length === 0 && notes.length === 0) {
    return (
      <EmptyState icon={Sparkles} title="No analysis for this run yet">
        Run <code className="font-mono text-xs">reeval analyze {runId} --save</code> to write one
        into the run's history folder, or{' '}
        <code className="font-mono text-xs">reeval analyze --context</code> to hand the digest to
        your own coding agent.
      </EmptyState>
    )
  }
  const entry = entries.find((e) => e.file === picked) ?? entries[0]
  return (
    <div className="space-y-6">
      {entry && entries.length > 1 ? (
        <Select value={entry.file} onValueChange={setPicked}>
          <SelectTrigger className="w-full sm:w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {entries.map((e) => (
              <SelectItem key={e.file} value={e.file}>
                {formatDate(e.doc.createdAt)} · {e.source} · {e.doc.model}
                {e.doc.error !== undefined ? ' · failed' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {entry ? (
        <AnalysisView entry={entry} />
      ) : (
        <p className="text-sm text-muted-foreground">
          No summary of the run: run{' '}
          <code className="font-mono text-xs">reeval analyze {runId} --save</code> to write one.
        </p>
      )}
      {notes.length ? <Notes notes={notes} /> : null}
    </div>
  )
}
