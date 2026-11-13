// What reeval sends an OpenTelemetry collector, and where, from the standard `OTEL_*` variables:
// each signal's target, its requests in OTLP's JSON mapping, and one POST of a request over
// OTLP/HTTP as protobuf or JSON. Plain fetch: no OpenTelemetry SDK.
import { gzipSync } from 'node:zlib'
import type { RunSpan, SpanAttributes } from '../view/spans.ts'
import { encodeMessage, LOGS_REQUEST, METRICS_REQUEST, TRACES_REQUEST } from './otlp-proto.ts'

type Env = Record<string, string | undefined>

export type Signal = 'traces' | 'metrics' | 'logs'

export type OtlpTarget = {
  signal: Signal
  url: string
  headers: Record<string, string>
  protocol: 'http/protobuf' | 'http/json'
  gzip: boolean
  timeoutMs: number
}

/** What every request says it comes from: `service.name` and `OTEL_RESOURCE_ATTRIBUTES`. */
export type OtlpResource = Record<string, string>

const pairs = (text: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const part of (text ?? '').split(',')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    const key = part.slice(0, at).trim()
    const value = part.slice(at + 1).trim()
    try {
      out[key] = decodeURIComponent(value)
    } catch {
      out[key] = value
    }
  }
  return out
}

const set = (v: string | undefined) => (v?.trim() ? v.trim() : undefined)

/** Whether any signal could be exported, without reading the rest: a run checks this first. */
export function otlpConfigured(env: Env): boolean {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true') return false
  return !!(
    set(env.OTEL_EXPORTER_OTLP_ENDPOINT) ||
    set(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) ||
    set(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) ||
    set(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)
  )
}

/**
 * Where `signal` goes, or why it doesn't: null when no endpoint is set or its exporter is off, a
 * string when one is set but can't be used.
 */
export function otlpTarget(env: Env, signal: Signal = 'traces'): OtlpTarget | string | null {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true') return null
  const S = signal.toUpperCase()
  const exporters = set(env[`OTEL_${S}_EXPORTER`])
  if (exporters && !exporters.split(',').some((e) => e.trim() === 'otlp')) return null
  const own = set(env[`OTEL_EXPORTER_OTLP_${S}_ENDPOINT`])
  const base = set(env.OTEL_EXPORTER_OTLP_ENDPOINT)
  if (!own && !base) return null
  const protocol =
    set(env[`OTEL_EXPORTER_OTLP_${S}_PROTOCOL`]) ??
    set(env.OTEL_EXPORTER_OTLP_PROTOCOL) ??
    'http/protobuf'
  if (protocol !== 'http/protobuf' && protocol !== 'http/json') {
    return `reeval exports over OTLP/HTTP only, and the OTLP protocol is ${protocol}: set OTEL_EXPORTER_OTLP_PROTOCOL to http/protobuf or http/json`
  }
  const compression =
    set(env[`OTEL_EXPORTER_OTLP_${S}_COMPRESSION`]) ?? set(env.OTEL_EXPORTER_OTLP_COMPRESSION)
  if (compression && compression !== 'gzip' && compression !== 'none') {
    return `reeval compresses OTLP with gzip or none, and the OTLP compression is ${compression}`
  }
  const timeout = Number(
    set(env[`OTEL_EXPORTER_OTLP_${S}_TIMEOUT`]) ??
      set(env.OTEL_EXPORTER_OTLP_TIMEOUT) ??
      Number.NaN,
  )
  return {
    signal,
    url: own ?? `${(base as string).replace(/\/+$/, '')}/v1/${signal}`,
    headers: {
      ...pairs(env.OTEL_EXPORTER_OTLP_HEADERS),
      ...pairs(env[`OTEL_EXPORTER_OTLP_${S}_HEADERS`]),
    },
    protocol,
    gzip: compression === 'gzip',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000,
  }
}

export function otlpResource(env: Env): OtlpResource {
  const attributes = pairs(env.OTEL_RESOURCE_ATTRIBUTES)
  return {
    ...attributes,
    'service.name': set(env.OTEL_SERVICE_NAME) ?? attributes['service.name'] ?? 'reeval',
  }
}

const value = (v: string | number | boolean) =>
  typeof v === 'string'
    ? { stringValue: v }
    : typeof v === 'boolean'
      ? { boolValue: v }
      : Number.isInteger(v)
        ? { intValue: String(v) }
        : { doubleValue: v }

export const otlpAttributes = (attrs: SpanAttributes) =>
  Object.entries(attrs).map(([key, v]) => ({ key, value: value(v) }))

export const nanos = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString()

const scoped = (resource: OtlpResource, version: string) => ({
  resource: { attributes: otlpAttributes(resource) },
  scope: { name: 'reeval', version },
})

/** The spans as an OTLP `ExportTraceServiceRequest`, in its JSON mapping. */
export function tracesRequest(spans: readonly RunSpan[], resource: OtlpResource, version: string) {
  const { resource: r, scope } = scoped(resource, version)
  return {
    resourceSpans: [
      {
        resource: r,
        scopeSpans: [
          {
            scope,
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId && { parentSpanId: s.parentSpanId }),
              name: s.name,
              // SPAN_KIND_INTERNAL
              kind: 1,
              startTimeUnixNano: nanos(s.startMs),
              endTimeUnixNano: nanos(s.endMs),
              attributes: otlpAttributes(s.attributes),
              ...(s.links?.length && { links: s.links }),
              // STATUS_CODE_ERROR
              ...(s.status && { status: { code: 2, message: s.status.message ?? '' } }),
            })),
          },
        ],
      },
    ],
  }
}

/** One log record, as `logsRequest` sends it. */
export type OtlpLog = {
  timeMs: number
  severity: 'INFO' | 'WARN' | 'ERROR'
  body: string
  attributes: SpanAttributes
  traceId?: string
}

const SEVERITY = { INFO: 9, WARN: 13, ERROR: 17 } as const

/** The records as an OTLP `ExportLogsServiceRequest`, in its JSON mapping. */
export function logsRequest(logs: readonly OtlpLog[], resource: OtlpResource, version: string) {
  const { resource: r, scope } = scoped(resource, version)
  return {
    resourceLogs: [
      {
        resource: r,
        scopeLogs: [
          {
            scope,
            logRecords: logs.map((l) => ({
              timeUnixNano: nanos(l.timeMs),
              observedTimeUnixNano: nanos(l.timeMs),
              severityNumber: SEVERITY[l.severity],
              severityText: l.severity,
              body: { stringValue: l.body },
              attributes: otlpAttributes(l.attributes),
              ...(l.traceId && { traceId: l.traceId }),
            })),
          },
        ],
      },
    ],
  }
}

/** One metric's points at one time, as `metricsRequest` sends it. */
export type OtlpMetric = {
  name: string
  unit: string
  description: string
  /** A gauge, or a cumulative non-monotonic sum (an up-down counter) from `startMs`. */
  type: 'gauge' | 'updown'
  startMs: number
  timeMs: number
  points: Array<{ value: number; int?: boolean; attributes?: SpanAttributes }>
}

/** The metrics as an OTLP `ExportMetricsServiceRequest`, in its JSON mapping. */
export function metricsRequest(
  metrics: readonly OtlpMetric[],
  resource: OtlpResource,
  version: string,
) {
  const { resource: r, scope } = scoped(resource, version)
  return {
    resourceMetrics: [
      {
        resource: r,
        scopeMetrics: [
          {
            scope,
            metrics: metrics.map((m) => {
              const dataPoints = m.points.map((p) => ({
                startTimeUnixNano: nanos(m.startMs),
                timeUnixNano: nanos(m.timeMs),
                ...(p.int ? { asInt: String(Math.round(p.value)) } : { asDouble: p.value }),
                attributes: otlpAttributes(p.attributes ?? {}),
              }))
              return {
                name: m.name,
                unit: m.unit,
                description: m.description,
                ...(m.type === 'gauge'
                  ? { gauge: { dataPoints } }
                  : // AGGREGATION_TEMPORALITY_CUMULATIVE
                    { sum: { dataPoints, aggregationTemporality: 2, isMonotonic: false } }),
              }
            }),
          },
        ],
      },
    ],
  }
}

const MESSAGES = { traces: TRACES_REQUEST, logs: LOGS_REQUEST, metrics: METRICS_REQUEST }

/** A request's body as `target` sends it, and its content type. */
export function otlpBody(target: OtlpTarget, request: object) {
  const raw =
    target.protocol === 'http/json'
      ? new TextEncoder().encode(JSON.stringify(request))
      : encodeMessage(MESSAGES[target.signal], request as Record<string, unknown>)
  return {
    body: target.gzip ? new Uint8Array(gzipSync(raw)) : raw,
    contentType: target.protocol === 'http/json' ? 'application/json' : 'application/x-protobuf',
  }
}

/** The URL as a message may show it: no user, password or query, which can carry a token. */
export function shownUrl(url: string): string {
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return 'the collector'
  }
}

/** Posts one request; resolves to null, or to why it wasn't taken. Never throws. */
export async function postOtlp(
  target: OtlpTarget,
  request: object,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const url = shownUrl(target.url)
  try {
    const { body, contentType } = otlpBody(target, request)
    const response = await fetcher(target.url, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        ...(target.gzip && { 'content-encoding': 'gzip' }),
        ...target.headers,
      },
      body: body as Uint8Array<ArrayBuffer>,
      signal: AbortSignal.timeout(target.timeoutMs),
    })
    await response.body?.cancel().catch(() => {})
    return response.ok ? null : `${url} answered ${response.status}`
  } catch (error) {
    // A malformed header value comes back in fetch's own message.
    const message = Object.values(target.headers)
      .filter(Boolean)
      .reduce(
        (m, v) => m.split(v).join('***'),
        (error as Error).message.split(target.url).join(url),
      )
    return `couldn't reach ${url}: ${message}`
  }
}
