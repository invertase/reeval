// Which OpenTelemetry signals a run exports, from the standard `OTEL_*` variables. The OTLP
// exporters read the rest (endpoint, headers, timeout, compression, certificates) themselves, but
// default to a collector on localhost, so a signal is on only when an endpoint names one. Imports no
// SDK: every run checks this first.

type Env = Record<string, string | undefined>

export type Signal = 'traces' | 'metrics' | 'logs'

export type OtlpProtocol = 'http/protobuf' | 'http/json'

const set = (v: string | undefined) => (v?.trim() ? v.trim() : undefined)

const disabled = (env: Env) => env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true'

/** Whether any signal could be exported, without reading the rest. */
export function otlpConfigured(env: Env): boolean {
  if (disabled(env)) return false
  return !!(
    set(env.OTEL_EXPORTER_OTLP_ENDPOINT) ||
    set(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) ||
    set(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) ||
    set(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)
  )
}

/**
 * The protocol `signal` goes over, or why it doesn't: null when no endpoint is set or its exporter
 * is off, `refused` when one is set but can't be used.
 */
export function otlpProtocol(env: Env, signal: Signal): OtlpProtocol | null | { refused: string } {
  if (disabled(env)) return null
  const S = signal.toUpperCase()
  const exporters = set(env[`OTEL_${S}_EXPORTER`])
  if (exporters && !exporters.split(',').some((e) => e.trim() === 'otlp')) return null
  if (!set(env[`OTEL_EXPORTER_OTLP_${S}_ENDPOINT`]) && !set(env.OTEL_EXPORTER_OTLP_ENDPOINT)) {
    return null
  }
  const protocol =
    set(env[`OTEL_EXPORTER_OTLP_${S}_PROTOCOL`]) ??
    set(env.OTEL_EXPORTER_OTLP_PROTOCOL) ??
    'http/protobuf'
  if (protocol === 'http/protobuf' || protocol === 'http/json') return protocol
  return {
    refused: `reeval exports over OTLP/HTTP only, and the OTLP protocol is ${protocol}: set OTEL_EXPORTER_OTLP_PROTOCOL to http/protobuf or http/json`,
  }
}
