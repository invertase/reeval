// `reeval run --retry-errors`: what refuses a retry because the plan isn't the run's any more, and
// how the retried attempts came out.
import type { PlannedItem } from './engine/types.ts'
import { evalFile, sourcesPart } from './eval-source.ts'
import { gatewayPart, harnessPart } from './history/assemble.ts'
import type { FingerprintParts, RunRecord } from './history/types.ts'
import type { Outcome } from './types.ts'
import { gatePart } from './view/gate.ts'

const PARTS: Array<[keyof FingerprintParts, string]> = [
  ['sources', 'eval source'],
  ['harness', 'harness'],
  ['gateway', 'gateway'],
  ['gate', 'gate'],
]

const listed = (names: string[]) =>
  names.length > 3
    ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
    : names.join(', ')

/**
 * How the plan differs from the run it would retry into, as sentences; none when it's the run's.
 * The attempts it would leave out or add, then the fingerprint parts a retried attempt's cell
 * would get from this plan that its cell in the run doesn't have.
 */
export async function retryChanges(
  previous: RunRecord,
  planned: readonly PlannedItem[],
  errored: ReadonlySet<string>,
  root: string,
): Promise<string[]> {
  const had = new Map(previous.evals.flatMap((e) => e.attempts.map((a) => [a.key, e] as const)))
  const now = new Map(planned.map((p) => [p.key, p]))
  const changes: string[] = []
  const gone = [...errored].filter((k) => !now.has(k))
  if (gone.length) changes.push(`it no longer plans ${listed(gone)}`)
  const added = planned.filter((p) => !p.attempt.plan.skip && !had.has(p.key)).map((p) => p.key)
  if (added.length) changes.push(`it plans ${listed(added)}, which the run didn't`)
  const files = new Map<string, Array<{ path: string; sha256: string }>>()
  const parts = new Map<string, Set<string>>()
  for (const key of errored) {
    const p = now.get(key)
    const cell = had.get(key)?.cells.find((c) => c.key === p?.attempt.cell.key)
    if (!p || !cell?.fingerprintParts) continue
    if (!files.has(p.file)) files.set(p.file, await evalFile(root, p.file))
    const { attempt } = p
    const current: Partial<FingerprintParts> = {
      sources: sourcesPart(attempt.source, attempt.revision, files.get(p.file) ?? []),
      harness: harnessPart(attempt.harness),
      ...gatewayPart(attempt.gateway),
      ...gatePart(attempt.gate),
    }
    for (const [part, name] of PARTS) {
      if (current[part] === cell.fingerprintParts[part]) continue
      parts.set(name, (parts.get(name) ?? new Set()).add(p.id))
    }
  }
  for (const [name, ids] of parts) changes.push(`the ${name} of ${listed([...ids])} changed`)
  return changes
}

export type RetryCounts = { retried: number } & Partial<Record<Outcome, number>>

/** How each attempt the run ran again came out, by its outcome in the record. */
export function retryCounts(record: RunRecord, retried: ReadonlySet<string>): RetryCounts {
  const counts: RetryCounts = { retried: 0 }
  for (const a of record.evals.flatMap((e) => e.attempts)) {
    if (!retried.has(a.key)) continue
    counts.retried++
    counts[a.outcome] = (counts[a.outcome] ?? 0) + 1
  }
  return counts
}

/** `retried 2 errored attempts: 1 now passes, 1 fails, 0 still errors`. */
export function retryLine({ retried, ...counts }: RetryCounts): string {
  const n = (outcome: Outcome) => counts[outcome] ?? 0
  const passes = `${n('pass')} now ${n('pass') === 1 ? 'passes' : 'pass'}`
  const fails = `${n('fail')} ${n('fail') === 1 ? 'fails' : 'fail'}`
  const errors = `${n('infra_error')} still ${n('infra_error') === 1 ? 'errors' : 'error'}`
  const rest = retried - n('pass') - n('fail') - n('infra_error')
  const left = rest ? `, ${rest} didn't finish` : ''
  return `retried ${retried} errored attempt${retried === 1 ? '' : 's'}: ${passes}, ${fails}, ${errors}${left}`
}
