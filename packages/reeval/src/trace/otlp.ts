// Sends a run's spans to an OpenTelemetry collector over OTLP/HTTP as JSON, when the standard
// `OTEL_EXPORTER_OTLP_*` variables name one. Plain fetch: no OpenTelemetry SDK.
import type { RunSpan } from '../view/spans.ts'

type Env = Record<string, string | undefined>

export type OtlpTarget = {
  url: string
  headers: Record<string, string>
  serviceName: string
  resource: Record<string, string>
  timeoutMs: number
}

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

/**
 * Where the spans go, or why they don't: null when no endpoint is set, a string when one is set
 * but can't be used.
 */
export function otlpTarget(env: Env): OtlpTarget | string | null {
  const exporters = env.OTEL_TRACES_EXPORTER?.trim()
  if (exporters && !exporters.split(',').some((e) => e.trim() === 'otlp')) return null
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  if (!traces && !base) return null
  const protocol = (
    env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL
  )?.trim()
  if (protocol && protocol !== 'http/json') {
    return `reeval exports spans over OTLP/HTTP as JSON only, and OTEL_EXPORTER_OTLP_PROTOCOL is ${protocol}: set it to http/json`
  }
  const timeout = Number(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT ?? env.OTEL_EXPORTER_OTLP_TIMEOUT)
  const resource = pairs(env.OTEL_RESOURCE_ATTRIBUTES)
  return {
    url: traces || `${(base as string).replace(/\/+$/, '')}/v1/traces`,
    headers: {
      ...pairs(env.OTEL_EXPORTER_OTLP_HEADERS),
      ...pairs(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
    },
    serviceName: env.OTEL_SERVICE_NAME?.trim() || resource['service.name'] || 'reeval',
    resource,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000,
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

const attributes = (attrs: Record<string, string | number | boolean>) =>
  Object.entries(attrs).map(([key, v]) => ({ key, value: value(v) }))

const nanos = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString()

/** The spans as an OTLP `ExportTraceServiceRequest`, in its JSON mapping. */
export function otlpRequest(spans: readonly RunSpan[], target: OtlpTarget, version: string) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: attributes({ ...target.resource, 'service.name': target.serviceName }),
        },
        scopeSpans: [
          {
            scope: { name: 'reeval', version },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId && { parentSpanId: s.parentSpanId }),
              name: s.name,
              // SPAN_KIND_INTERNAL
              kind: 1,
              startTimeUnixNano: nanos(s.startMs),
              endTimeUnixNano: nanos(s.endMs),
              attributes: attributes(s.attributes),
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

/** Posts the spans; resolves to null, or to why they weren't sent. Never throws. */
export async function exportSpans(
  spans: readonly RunSpan[],
  env: Env,
  version: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const target = otlpTarget(env)
  if (target === null || !spans.length) return null
  if (typeof target === 'string') return target
  try {
    const response = await fetcher(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...target.headers },
      body: JSON.stringify(otlpRequest(spans, target, version)),
      signal: AbortSignal.timeout(target.timeoutMs),
    })
    await response.body?.cancel().catch(() => {})
    return response.ok ? null : `${target.url} answered ${response.status}`
  } catch (error) {
    return `couldn't reach ${target.url}: ${(error as Error).message}`
  }
}
