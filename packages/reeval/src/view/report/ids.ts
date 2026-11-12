import type { EvalEntry, RunRecord } from '../../history/types.ts'
import { sha256Hex } from '../../sha256.ts'
import { slugify } from '../../slug.ts'

export type AttemptIdMap = ReadonlyMap<string, string>

/**
 * Stable short IDs `A1..AN` for every attempt that started (`seq !== null`),
 * ordered by `seq` across the (optionally filtered) evals. Every block cites
 * through this map.
 */
export function attemptIds(
  record: Pick<RunRecord, 'evals'>,
  evalKeys?: ReadonlySet<string>,
): AttemptIdMap {
  const attempts = record.evals
    .filter((e) => !evalKeys || evalKeys.has(e.key))
    .flatMap((e) => e.attempts.map((a) => ({ eval: e, attempt: a })))
    .filter((row) => row.attempt.seq !== null)
    .sort((a, b) => (a.attempt.seq as number) - (b.attempt.seq as number))

  const map = new Map<string, string>()
  let n = 1
  for (const row of attempts) {
    map.set(row.attempt.key, `A${n++}`)
  }
  return map
}

/** The short ID for an attempt key, or null when it never started. */
export function idOf(ids: AttemptIdMap, attemptKey: string): string | null {
  return ids.get(attemptKey) ?? null
}

/**
 * The HTML id of an attempt's row in the attempt index, from its stable key, so a link to it holds
 * in any report of the run: `attempt-` and a slug of the key, with a hash of the whole key that
 * keeps two keys whose slugs match apart.
 */
export function attemptAnchorId(key: string): string {
  return `attempt-${slugify(key, 60) || 'key'}-${sha256Hex(key).slice(0, 8)}`
}

/** Anchor fragment for an attempt: `#` and its `attemptAnchorId`. */
export function attemptAnchor(key: string): string {
  return `#${attemptAnchorId(key)}`
}

/** Eval entries in report order, optionally filtered by `options.evals`. */
export function selectedEvals(
  record: Pick<RunRecord, 'evals'>,
  keys?: readonly string[],
): EvalEntry[] {
  if (!keys || keys.length === 0) return [...record.evals]
  const want = new Set(keys)
  return record.evals.filter((e) => want.has(e.key))
}
