/**
 * OpenTelemetry's variables configure reeval's own export on the host, and
 * `OTEL_EXPORTER_OTLP_HEADERS` and its per-signal forms carry the backend's credentials, so none
 * reaches a sandbox, a provider's machine or the agent: an eval can't declare one, and the
 * sandbox drops any that would get in another way.
 */
const OTEL = /^otel_/i

export const isOtelVar = (name: string): boolean => OTEL.test(name)

/** `env` without its `OTEL_*` variables; the fake sandbox's host shell gets them unset. */
export function withoutOtel<T extends string | undefined>(
  env: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isOtelVar(name)))
}

export const otelRefusal = (what: string): string =>
  `${what} is an OpenTelemetry variable, which reeval keeps out of the sandbox: its own OTLP export reads OTEL_* on the host, and the agent never sees them.`
