// A run's OpenTelemetry export, when the `OTEL_EXPORTER_OTLP_*` variables name a collector: its
// spans as each ends, its notices and finished attempts as log records, and the machine's metrics
// on an interval, each in batches during the run. Nothing here can fail the run: an export that
// fails is a reason `close` resolves to.
import { redactSecrets } from '../redact.ts'
import type { ReevalEvent } from '../ui/events.ts'
import type { RunSpan, SpanAttributes } from '../view/spans.ts'
import { Batcher, batchOptions } from './batch.ts'
import { HostMetrics } from './host-metrics.ts'
import {
  logsRequest,
  metricsRequest,
  type OtlpLog,
  type OtlpTarget,
  otlpResource,
  otlpTarget,
  postOtlp,
  tracesRequest,
} from './otlp.ts'

type Env = Record<string, string | undefined>

export type Telemetry = {
  span(span: RunSpan): void
  event(e: ReevalEvent): void
  /** Sends what's left and stops; resolves to null, or to why something wasn't sent. */
  close(): Promise<string | null>
}

const firstLine = (text: string) => redactSecrets(text.split('\n')[0] ?? '').slice(0, 1000)

export function startTelemetry(o: {
  env: Env
  version: string
  traceId: string
  runId: string
  /** The filesystems the run writes to, for the metrics. */
  paths: string[]
  fetcher?: typeof fetch
}): Telemetry | null {
  const { env, version, traceId, runId, fetcher } = o
  const refusals: string[] = []
  const target = (signal: 'traces' | 'logs' | 'metrics') => {
    const t = otlpTarget(env, signal)
    if (typeof t === 'string') refusals.push(t)
    return typeof t === 'object' ? t : null
  }
  const traces = target('traces')
  const logs = target('logs')
  const metrics = target('metrics')
  if (!traces && !logs && !metrics && !refusals.length) return null
  const resource = otlpResource(env)
  const post = (t: OtlpTarget, request: object) => postOtlp(t, request, fetcher)

  const spans =
    traces &&
    new Batcher<RunSpan>(
      (batch) => post(traces, tracesRequest(batch, resource, version)),
      batchOptions(env, 'BSP'),
      'spans',
    )
  const records =
    logs &&
    new Batcher<OtlpLog>(
      (batch) => post(logs, logsRequest(batch, resource, version)),
      batchOptions(env, 'BLRP'),
      'log records',
    )
  const log = (l: Omit<OtlpLog, 'traceId'>) =>
    records?.add({ ...l, attributes: { 'reeval.run.id': runId, ...l.attributes }, traceId })

  let sampling: Promise<string | null> = Promise.resolve(null)
  let timer: ReturnType<typeof setInterval> | undefined
  const host = metrics && new HostMetrics(o.paths)
  let metricsWhy: string | null = null
  const sample = () => {
    if (!metrics || !host) return
    const request = metricsRequest(host.sample(), resource, version)
    sampling = sampling.then(async () => {
      const why = await post(metrics, request)
      metricsWhy ??= why
      return null
    })
  }
  if (metrics) {
    const every = Number(env.OTEL_METRIC_EXPORT_INTERVAL)
    timer = setInterval(sample, Number.isFinite(every) && every > 0 ? every : 60_000)
    timer.unref?.()
  }

  let closed = false
  return {
    span(span) {
      spans?.add(span)
    },
    event(e) {
      if (closed) return
      if (e.type === 'notice') {
        const severity = e.level === 'error' ? 'ERROR' : e.level === 'warn' ? 'WARN' : 'INFO'
        log({
          timeMs: e.at,
          severity,
          body: redactSecrets(e.text),
          attributes: { 'reeval.event': 'notice' },
        })
      } else if (e.type === 'eval-end' && e.result.state !== 'skipped') {
        const r = e.result
        const attributes: SpanAttributes = {
          'reeval.event': 'attempt',
          'reeval.attempt.key': r.key,
          'reeval.eval.name': r.name,
          'reeval.eval.file': r.file,
          'reeval.attempt.state': r.state,
          'reeval.attempt.duration_ms': Math.round(r.durationMs),
          ...(r.attempt && { 'reeval.attempt.label': r.attempt.label }),
          ...(r.errors[0] && { 'reeval.attempt.error': firstLine(r.errors[0]) }),
        }
        log({
          timeMs: e.at,
          severity: r.state === 'failed' ? 'WARN' : 'INFO',
          body: `${r.state} ${r.name}${r.attempt ? ` (${r.attempt.label})` : ''}`,
          attributes,
        })
      } else if (e.type === 'run-start') {
        log({
          timeMs: e.at,
          severity: 'INFO',
          body: 'run started',
          attributes: { 'reeval.event': 'run-start' },
        })
      }
    },
    async close() {
      if (closed) return null
      closed = true
      clearInterval(timer)
      sample()
      const whys = await Promise.all([
        spans?.close() ?? null,
        records?.close() ?? null,
        sampling.then(() => metricsWhy && `metrics: ${metricsWhy}`),
      ])
      const all = [...new Set(refusals), ...whys.filter((w): w is string => !!w)]
      return all.length ? all.join('; ') : null
    },
  }
}
