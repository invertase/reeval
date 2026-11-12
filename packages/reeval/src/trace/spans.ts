// Spans for the run's trace (`view/spans.ts`), from any of its processes. The main process writes
// the file (`run.ts`); a worker sends each span there over its service channel once it ends, and
// the main process fills in the trace id and, for a span with no parent, the run's span.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { redactSecrets } from '../redact.ts'
import { callService, hasServiceChannel } from '../scheduler/services.ts'
import type { RunSpan, SpanAttributes } from '../view/spans.ts'

export const TRACE = 'trace'

/** A span as its process makes it: the run's writer fills in what's missing. */
export type SpanInput = Omit<RunSpan, 'traceId' | 'parentSpanId'> & {
  traceId?: string
  parentSpanId?: string
}

export const newSpanId = (): string => randomBytes(8).toString('hex')

/** Where this process's spans go when it has no service channel: the run's writer, or nowhere. */
let local: ((span: SpanInput) => void) | undefined

export function setLocalSpanSink(sink: ((span: SpanInput) => void) | undefined): void {
  local = sink
}

/** Sends a finished span to the run's trace; never throws, and never holds the caller up. */
export function emitSpan(span: SpanInput): void {
  if (hasServiceChannel()) {
    callService(TRACE, span, async () => null).catch(() => {})
    return
  }
  try {
    local?.(span)
  } catch {}
}

/** A span under way: emitted once, on its first `end`. */
export type OpenSpan = {
  readonly spanId: string
  set(attributes: SpanAttributes): void
  link(spanId: string): void
  end(error?: unknown): void
}

export function openSpan(
  name: string,
  attributes: SpanAttributes = {},
  o: { parentSpanId?: string | undefined; startMs?: number } = {},
): OpenSpan {
  const spanId = newSpanId()
  const startMs = o.startMs ?? Date.now()
  const attrs: SpanAttributes = { ...attributes }
  const links: string[] = []
  let ended = false
  return {
    spanId,
    set(more) {
      Object.assign(attrs, more)
    },
    link(id) {
      links.push(id)
    },
    end(error) {
      if (ended) return
      ended = true
      emitSpan({
        spanId,
        ...(o.parentSpanId && { parentSpanId: o.parentSpanId }),
        name,
        startMs,
        endMs: Date.now(),
        attributes: attrs,
        ...(error !== undefined && {
          status: {
            code: 'error' as const,
            message: redactSecrets(error instanceof Error ? error.message : String(error)),
          },
        }),
        ...(links.length && { links: links.map((spanId) => ({ traceId: '', spanId })) }),
      })
    },
  }
}

const current = new AsyncLocalStorage<OpenSpan>()

/** Runs `fn` with `span` as the attempt's, so the sandbox code under it can say where it ran. */
export const withAttemptSpan = <T>(span: OpenSpan, fn: () => T): T => current.run(span, fn)

/** The running attempt's span, if any. */
export const attemptSpan = (): OpenSpan | undefined => current.getStore()

/** A span under the running attempt's, or under the run's outside one. */
export const childSpan = (name: string, attributes?: SpanAttributes): OpenSpan =>
  openSpan(name, attributes, { parentSpanId: attemptSpan()?.spanId })
