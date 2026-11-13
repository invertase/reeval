// A run's OpenTelemetry export, when the `OTEL_EXPORTER_OTLP_*` variables name a collector, on the
// OpenTelemetry SDK: its spans as each ends (a batch span processor), its notices and finished
// attempts as log records (a batch log record processor), and the machine's metrics on an interval
// (a periodic metric reader), each to its OTLP exporter, which reads its own variables from
// `process.env`. Nothing here can fail the run: an export that fails is a reason `close` resolves
// to, and `close` waits at most CLOSE_MS.
import type { Agent } from 'node:http'
import type { Socket } from 'node:net'
import {
  type Attributes,
  DiagLogLevel,
  diag,
  ROOT_CONTEXT,
  SeverityNumber,
  type SpanContext,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
  ValueType,
} from '@opentelemetry/api'
import {
  type ExportResult,
  ExportResultCode,
  getNumberFromEnv,
  hrTimeDuration,
  millisToHrTime,
} from '@opentelemetry/core'
import { OTLPLogExporter as JsonLogs } from '@opentelemetry/exporter-logs-otlp-http'
import { OTLPLogExporter as ProtoLogs } from '@opentelemetry/exporter-logs-otlp-proto'
import { OTLPMetricExporter as JsonMetrics } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPMetricExporter as ProtoMetrics } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPTraceExporter as JsonTraces } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPTraceExporter as ProtoTraces } from '@opentelemetry/exporter-trace-otlp-proto'
import { OTLPExporterError } from '@opentelemetry/otlp-exporter-base'
import { convertLegacyHttpOptions } from '@opentelemetry/otlp-exporter-base/node-http'
import { detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { BatchSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace'
import { redactSecrets } from '../redact.ts'
import type { ReevalEvent } from '../ui/events.ts'
import type { RunSpan } from '../view/spans.ts'
import { HOST_METRICS, type HostMetric, HostMetrics } from './host-metrics.ts'
import { type OtlpProtocol, otlpProtocol, type Signal } from './otlp.ts'

/**
 * How long `close` waits for what's left to be sent, and each export's default timeout: the
 * processors' export timers keep the process running, so this bounds how long reeval stays up.
 */
export const CLOSE_MS = 5_000

export type Telemetry = {
  span(span: RunSpan): void
  event(e: ReevalEvent): void
  /** Sends what's left and stops; resolves to null, or to why something wasn't sent. */
  close(): Promise<string | null>
}

/** A message as a warning may show it: one line, no secrets, no credentials in a URL. */
const shown = (text: string) =>
  redactSecrets((text.split('\n')[0] ?? '').replace(/\/\/[^/\s@]+@/g, '//')).slice(0, 1000)

/**
 * The agent the SDK builds from the environment (its certificates), with sockets that never keep
 * reeval running: `close` bounds the wait, and the exporter neither aborts a request nor
 * destroys its agent on shutdown.
 */
function detachedAgents(signal: Signal) {
  const fromEnv = convertLegacyHttpOptions(
    {},
    signal.toUpperCase(),
    `v1/${signal}`,
    {},
  ).agentFactory
  return async (protocol: string): Promise<Agent> => {
    const agent = await fromEnv(protocol)
    const create = agent.createConnection.bind(agent)
    agent.createConnection = (...args: Parameters<Agent['createConnection']>) => {
      const socket = create(...args) as Socket | null | undefined
      socket?.unref()
      return socket
    }
    const reuse = agent.reuseSocket.bind(agent)
    agent.reuseSocket = (socket, request) => {
      reuse(socket, request)
      ;(socket as Socket).unref()
    }
    return agent
  }
}

const NOUN = {
  traces: ['span', 'spans'],
  logs: ['log record', 'log records'],
  metrics: ['metric export', 'metric exports'],
} as const

const positive = (name: string, fallback: number) => {
  const n = getNumberFromEnv(name)
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : fallback
}

export function startTelemetry(o: {
  version: string
  traceId: string
  /** The run's span, which the log records belong to. */
  spanId: string
  runId: string
  /** The filesystems the run writes to, by role, for the metrics. */
  filesystems: Record<string, string>
}): Telemetry | null {
  const { version, traceId, spanId, runId } = o
  const env = process.env
  const reasons = new Set<string>()
  const protocols: Partial<Record<Signal, OtlpProtocol>> = {}
  for (const signal of ['traces', 'logs', 'metrics'] as const) {
    const p = otlpProtocol(env, signal)
    if (p && typeof p === 'object') reasons.add(p.refused)
    else if (p) protocols[signal] = p
  }
  if (!protocols.traces && !protocols.logs && !protocols.metrics && !reasons.size) return null

  diag.setLogger(
    {
      // The SDK reports a failed export here too, with its stack: `watched` names those.
      error: () => {},
      warn: (message) => reasons.add(shown(message)),
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true },
  )

  const failed = new Map<Signal, { why: string; items: number }>()
  const watched = <E extends { export(items: never, done: (r: ExportResult) => void): void }>(
    signal: Signal,
    e: E,
  ): E => {
    const send = e.export.bind(e) as (items: unknown, done: (r: ExportResult) => void) => void
    ;(e as unknown as { export: typeof send }).export = (items, done) =>
      send(items, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) {
          const error = result.error
          const why =
            error instanceof OTLPExporterError && error.code
              ? `the collector answered ${error.code}`
              : shown(error?.message ?? 'the export failed')
          const seen = failed.get(signal)
          failed.set(signal, {
            why: seen?.why ?? why,
            items: (seen?.items ?? 0) + (Array.isArray(items) ? items.length : 1),
          })
        }
        done(result)
      })
    return e
  }
  const options = (signal: Signal) => ({ httpAgentOptions: detachedAgents(signal) })

  const resource = resourceFromAttributes({ 'service.name': 'reeval' }).merge(
    detectResources({ detectors: [envDetector] }),
  )
  const scope = { name: 'reeval', version }

  const spans =
    protocols.traces &&
    new BatchSpanProcessor({
      exporter: watched(
        'traces',
        new (protocols.traces === 'http/json' ? JsonTraces : ProtoTraces)(options('traces')),
      ),
      scheduledDelayMillis: positive('OTEL_BSP_SCHEDULE_DELAY', 5000),
      maxQueueSize: positive('OTEL_BSP_MAX_QUEUE_SIZE', 2048),
      maxExportBatchSize: Math.min(
        positive('OTEL_BSP_MAX_EXPORT_BATCH_SIZE', 512),
        positive('OTEL_BSP_MAX_QUEUE_SIZE', 2048),
      ),
      exportTimeoutMillis: positive('OTEL_BSP_EXPORT_TIMEOUT', CLOSE_MS),
    })
  const context = (id: string, of = traceId): SpanContext => ({
    traceId: of,
    spanId: id,
    traceFlags: TraceFlags.SAMPLED,
  })
  const readable = (s: RunSpan): ReadableSpan => {
    const startTime = millisToHrTime(s.startMs)
    const endTime = millisToHrTime(s.endMs)
    return {
      name: s.name,
      kind: SpanKind.INTERNAL,
      spanContext: () => context(s.spanId, s.traceId),
      ...(s.parentSpanId && { parentSpanContext: context(s.parentSpanId, s.traceId) }),
      startTime,
      endTime,
      duration: hrTimeDuration(startTime, endTime),
      status: s.status
        ? { code: SpanStatusCode.ERROR, message: s.status.message ?? '' }
        : { code: SpanStatusCode.UNSET },
      attributes: s.attributes,
      links: (s.links ?? []).map((l) => ({ context: context(l.spanId, l.traceId) })),
      events: [],
      ended: true,
      resource,
      instrumentationScope: scope,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    }
  }

  const loggers =
    protocols.logs &&
    new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor({
          exporter: watched(
            'logs',
            new (protocols.logs === 'http/json' ? JsonLogs : ProtoLogs)(options('logs')),
          ),
          scheduledDelayMillis: positive('OTEL_BLRP_SCHEDULE_DELAY', 1000),
          maxQueueSize: positive('OTEL_BLRP_MAX_QUEUE_SIZE', 2048),
          maxExportBatchSize: Math.min(
            positive('OTEL_BLRP_MAX_EXPORT_BATCH_SIZE', 512),
            positive('OTEL_BLRP_MAX_QUEUE_SIZE', 2048),
          ),
          exportTimeoutMillis: positive('OTEL_BLRP_EXPORT_TIMEOUT', CLOSE_MS),
        }),
      ],
    })
  const logger = loggers?.getLogger('reeval', version)
  const onRun = trace.setSpanContext(ROOT_CONTEXT, context(spanId))
  const SEVERITY = {
    INFO: SeverityNumber.INFO,
    WARN: SeverityNumber.WARN,
    ERROR: SeverityNumber.ERROR,
  } as const
  const log = (
    timeMs: number,
    severity: keyof typeof SEVERITY,
    body: string,
    attributes: Attributes,
  ) =>
    logger?.emit({
      timestamp: timeMs,
      observedTimestamp: timeMs,
      severityNumber: SEVERITY[severity],
      severityText: severity,
      body,
      attributes: { 'reeval.run.id': runId, ...attributes },
      context: onRun,
    })

  let meters: MeterProvider | undefined
  if (protocols.metrics) {
    const every = positive('OTEL_METRIC_EXPORT_INTERVAL', 60_000)
    meters = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: watched(
            'metrics',
            new (protocols.metrics === 'http/json' ? JsonMetrics : ProtoMetrics)(
              options('metrics'),
            ),
          ),
          exportIntervalMillis: every,
          exportTimeoutMillis: Math.min(positive('OTEL_METRIC_EXPORT_TIMEOUT', CLOSE_MS), every),
        }),
      ],
    })
    const meter = meters.getMeter('reeval', version)
    const host = new HostMetrics(o.filesystems)
    const instruments = Object.fromEntries(
      Object.entries(HOST_METRICS).map(([name, m]) => [
        name,
        m.bytes
          ? meter.createObservableUpDownCounter(name, {
              unit: m.unit,
              description: m.description,
              valueType: ValueType.INT,
            })
          : meter.createObservableGauge(name, { unit: m.unit, description: m.description }),
      ]),
    ) as Record<HostMetric, ReturnType<typeof meter.createObservableGauge>>
    meter.addBatchObservableCallback((result) => {
      for (const p of host.sample()) {
        const value = HOST_METRICS[p.name].bytes ? Math.round(p.value) : p.value
        result.observe(instruments[p.name], value, p.attributes)
      }
    }, Object.values(instruments))
  }

  let closed = false
  return {
    span(span) {
      if (!closed) spans?.onEnd(readable(span))
    },
    event(e) {
      if (closed) return
      if (e.type === 'notice') {
        const severity = e.level === 'error' ? 'ERROR' : e.level === 'warn' ? 'WARN' : 'INFO'
        log(e.at, severity, redactSecrets(e.text), { 'reeval.event': 'notice' })
      } else if (e.type === 'eval-end' && e.result.state !== 'skipped') {
        const r = e.result
        log(
          e.at,
          r.state === 'failed' ? 'WARN' : 'INFO',
          `${r.state} ${r.name}${r.attempt ? ` (${r.attempt.label})` : ''}`,
          {
            'reeval.event': 'attempt',
            'reeval.attempt.key': r.key,
            'reeval.eval.name': r.name,
            'reeval.eval.file': r.file,
            'reeval.attempt.state': r.state,
            'reeval.attempt.duration_ms': Math.round(r.durationMs),
            ...(r.attempt && { 'reeval.attempt.label': r.attempt.label }),
            ...(r.errors[0] && { 'reeval.attempt.error': shown(r.errors[0]) }),
          },
        )
      } else if (e.type === 'run-start') {
        log(e.at, 'INFO', 'run started', { 'reeval.event': 'run-start' })
      }
    },
    async close() {
      if (closed) return null
      closed = true
      let timer: ReturnType<typeof setTimeout> | undefined
      const finished = await Promise.race([
        Promise.allSettled([spans?.shutdown(), loggers?.shutdown(), meters?.shutdown()]).then(
          () => true,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), CLOSE_MS)
        }),
      ])
      clearTimeout(timer)
      diag.disable()
      for (const [signal, f] of failed) {
        reasons.add(
          `${signal}: ${f.why} (${f.items} ${NOUN[signal][f.items === 1 ? 0 : 1]} not sent)`,
        )
      }
      if (!finished) {
        reasons.add(
          `the collector didn't take the rest within ${CLOSE_MS / 1000} s, so it wasn't sent`,
        )
      }
      return reasons.size ? [...reasons].join('; ') : null
    },
  }
}
