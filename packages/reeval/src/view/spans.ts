// A run's trace: what ran where and when, as `reeval run` writes it to `spans.jsonl` in the run's
// artifact directory, one span per line, shaped like an OpenTelemetry span. Browser-safe.
//
//   reeval.run          one per `reeval run` process (a resume adds another)
//   image.prepare       a preflight target: an image built, or found saved
//   machine             a VM: pooled (`boat()`, `daytona()`) from its start to its removal, or
//                       `tart()`'s from its boot to its deletion
//   container           a container: Docker's or Podman's, or one on a pooled VM (its parent)
//   attempt             one attempt, with where it ran (`host.id`, `container.id`, the slot)
//   lease               the attempt's slot on a pooled machine, linked to the machine's span
//   setup, agent, …     the attempt's phases, as its `timings` count them

import { fillDefaults } from './record.ts'

export const SPANS_FILE = 'spans.jsonl'

export type SpanAttributes = Record<string, string | number | boolean>

/** One span of a run's trace. */
export type RunSpan = {
  /** 32 hex characters, the same for every span of the run, its resumes' included. */
  traceId: string
  /** 16 hex characters. */
  spanId: string
  /** Absent on a `reeval.run` span, the trace's roots. */
  parentSpanId?: string
  name: string
  /** When it started and ended, in milliseconds since the epoch. */
  startMs: number
  endMs: number
  /**
   * What it was, with OpenTelemetry's names where they have one (`host.id`, `container.id`) and
   * `reeval.`'s otherwise.
   */
  attributes: SpanAttributes
  /** Set when what it covers failed. */
  status?: { code: 'error'; message?: string }
  /** Spans it relates to outside its parent: a lease's machine. */
  links?: Array<{ traceId: string; spanId: string }>
}

export const readableSpan = (span: RunSpan): RunSpan => fillDefaults('run-span', span)

/** A `spans.jsonl` file's spans, skipping a line cut short. */
export function parseSpans(text: string): RunSpan[] {
  const spans: RunSpan[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      spans.push(readableSpan(JSON.parse(line) as RunSpan))
    } catch {}
  }
  return spans
}
