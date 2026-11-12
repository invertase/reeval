// The run's trace in its main process: one `reeval.run` span over this `reeval run`, the spans
// every process sends it, appended to `spans.jsonl` in the run's staging directory as each ends,
// and the preflight's targets as `image.prepare` spans. Recording copies the file into the run's
// artifacts.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from '../sha256.ts'
import type { PrepareView } from '../ui/events.ts'
import { type RunSpan, SPANS_FILE, type SpanAttributes } from '../view/spans.ts'
import { newSpanId, type SpanInput, setLocalSpanSink } from './spans.ts'

/** The same for every process and resume of the run, so they add to one trace. */
export const traceIdOf = (runId: string): string => sha256Hex(`reeval-run:${runId}`).slice(0, 32)

export class RunTrace {
  readonly traceId: string
  readonly spanId = newSpanId()
  readonly #file: string
  readonly #startMs = Date.now()
  readonly #attributes: SpanAttributes
  readonly #spans: RunSpan[] = []
  readonly #images = new Map<string, { name: string; cached: boolean }>()
  #closed: RunSpan[] | undefined

  constructor(o: { dir: string; runId: string; attributes?: SpanAttributes }) {
    this.traceId = traceIdOf(o.runId)
    this.#file = join(o.dir, SPANS_FILE)
    this.#attributes = { 'reeval.run.id': o.runId, ...o.attributes }
  }

  /** Makes this process's spans this trace's, outside a worker. */
  install(): this {
    setLocalSpanSink((span) => this.add(span))
    return this
  }

  /** Adds a finished span: in a run's trace, under the run's span unless it names a parent. */
  add(span: SpanInput): void {
    if (this.#closed) return
    this.#write({
      ...span,
      traceId: this.traceId,
      parentSpanId: span.parentSpanId ?? this.spanId,
      ...(span.links && {
        links: span.links.map((l) => ({ traceId: this.traceId, spanId: l.spanId })),
      }),
    })
  }

  /** The `trace` service: a worker's finished span. */
  call(body: unknown): Promise<null> {
    this.add(body as SpanInput)
    return Promise.resolve(null)
  }

  /** A preflight target is one `image.prepare` span, written once it's ready or has failed. */
  prepare(e: PrepareView): void {
    if (e.state === 'start') return
    if (e.state === 'image') {
      this.#images.set(e.target.key, e.image)
      return
    }
    const { target, ms } = e.outcome
    const image = this.#images.get(target.key)
    const endMs = Date.now()
    this.add({
      spanId: newSpanId(),
      name: 'image.prepare',
      startMs: endMs - Math.round(ms),
      endMs,
      attributes: {
        'reeval.prepare.kind': target.kind,
        'reeval.prepare.target': target.label,
        ...(image && { 'container.image.name': image.name, 'reeval.image.cached': image.cached }),
      },
      ...(!e.outcome.ok && {
        status: { code: 'error' as const, message: e.outcome.failure.message.split('\n')[0] },
      }),
    })
  }

  /** Ends the run's span and stops taking spans; returns this process's, for an exporter. */
  close(o: { status?: string; error?: string } = {}): RunSpan[] {
    if (this.#closed) return this.#closed
    this.#write({
      traceId: this.traceId,
      spanId: this.spanId,
      name: 'reeval.run',
      startMs: this.#startMs,
      endMs: Date.now(),
      attributes: { ...this.#attributes, ...(o.status && { 'reeval.run.status': o.status }) },
      ...(o.error && { status: { code: 'error' as const, message: o.error } }),
    })
    setLocalSpanSink(undefined)
    this.#closed = this.#spans
    return this.#closed
  }

  #write(span: RunSpan) {
    this.#spans.push(span)
    try {
      mkdirSync(join(this.#file, '..'), { recursive: true })
      appendFileSync(this.#file, `${JSON.stringify(span)}\n`)
    } catch {}
  }
}
