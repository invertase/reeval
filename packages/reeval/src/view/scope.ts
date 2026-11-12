import { parseDuration } from '../duration.ts'
import type { RunRecord, RunScope } from '../history/types.ts'
import { sha256Hex } from './sha256.ts'

/** JSON with every object's keys sorted and `undefined` members left out, so equal data hashes equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v ?? null)).join(',')}]`
  if (value && typeof value === 'object') {
    const members = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    return `{${members.join(',')}}`
  }
  return JSON.stringify(value)
}

/** A duration as milliseconds, so `'10m'` and `600000` hash equal; a value it can't read, as written. */
function durationMs(value: string | number | undefined): string | number | undefined {
  if (value === undefined) return undefined
  try {
    return parseDuration(value)
  } catch {
    return value
  }
}

const sorted = (list: readonly string[] | undefined) => (list ? [...list].sort() : undefined)

function profileKey(profile: NonNullable<RunRecord['profile']>) {
  const { defaults, limit } = profile
  return {
    name: profile.name,
    defaults: {
      ...defaults,
      harness: sorted(defaults.harness),
      env: sorted(defaults.env),
      timeout: durationMs(defaults.timeout),
    },
    limit: {
      ...limit,
      harness: sorted(limit.harness),
      traits: limit.traits
        ? Object.fromEntries(
            Object.entries(limit.traits).map(([k, v]) => [
              k,
              typeof v === 'string' ? v : sorted(v),
            ]),
          )
        : undefined,
    },
  }
}

/** The run's scope, from its record alone; a record without `invocation` reads as one run with none. */
export function runScope(record: RunRecord): RunScope {
  const invocation = record.invocation
  const filters = invocation?.filters ?? []
  const tags = invocation?.tags ?? []
  const traits = invocation?.traits ?? []
  const { config } = record
  const key = {
    profile: record.profile ? profileKey(record.profile) : null,
    invocation: {
      runs: invocation?.runs,
      filters: sorted(filters),
      tags: sorted(tags),
      traits: sorted(traits),
    },
    config: {
      environment: config.environment,
      runs: config.runs,
      bestOf: config.bestOf,
      judgeModel: config.judgeModel,
      threshold: config.threshold,
      timeoutMs: config.timeoutMs,
    },
    fingerprintScope: sorted(record.stack.fingerprintScope),
  }
  return {
    profile: record.profile?.name ?? null,
    subset:
      filters.length > 0 || tags.length > 0 || traits.length > 0 || invocation?.runs !== undefined,
    configKey: sha256Hex(canonical(key)),
  }
}
