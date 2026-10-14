import type { HarnessDescriptor } from '../types.ts'

/**
 * The reasoning effort a harness asked for. Same user-facing name on every factory; the CLI's
 * native flag may say thinking. Undefined when the factory left it unset. Fast is not this.
 */
export function harnessEffort(h: HarnessDescriptor): string | undefined {
  return 'effort' in h && typeof h.effort === 'string' ? h.effort : undefined
}

/**
 * The reasoning effort a served-model label recorded, e.g. `gpt-5.6-luna[effort=medium]` →
 * `medium`. Fast (`[fast=true]`) is not effort and is ignored.
 */
export function effortFromModelLabel(model: string | null | undefined): string | undefined {
  const inner = model?.match(/\[([^\]]+)]/)?.[1]
  if (!inner) return undefined
  for (const part of inner.split(',')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    if (key === 'fast') continue
    if (/^(?:reasoning_)?effort$|^thinking$/.test(key)) {
      const value = part.slice(eq + 1).trim()
      if (value) return value
    }
  }
  return undefined
}

/** The first reasoning-effort suffix among served-model labels; undefined when none name one. */
export function servedEffortOf(
  models: Iterable<string | null | undefined> | null | undefined,
): string | undefined {
  if (!models) return undefined
  for (const model of models) {
    const effort = effortFromModelLabel(model)
    if (effort) return effort
  }
  return undefined
}

/** Unique reasoning-effort suffixes among served-model labels, in first-seen order. */
export function resolvedEffortOf(
  models: Iterable<string | null | undefined> | null | undefined,
): string[] {
  if (!models) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const model of models) {
    const effort = effortFromModelLabel(model)
    if (effort && !seen.has(effort)) {
      seen.add(effort)
      out.push(effort)
    }
  }
  return out
}
