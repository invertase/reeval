// The facts a run's insights were written from, as one hash: sha256 of its `SuiteResult` as
// canonical JSON (keys sorted), so the same facts always hash the same and any change to them,
// including how this reeval computes them, marks the insights stale.
import { sha256 } from '../ids.ts'
import type { SuiteResult } from '../view/suite.ts'

/** JSON with every object's keys sorted. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

export const factsHash = (suite: SuiteResult) => `sha256:${sha256(canonicalJson(suite))}`
