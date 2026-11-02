// `reeval run --retry-errors`: what refuses a retry because the plan isn't the run's any more, and
// how the retried attempts came out.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlannedItem } from './engine/types.ts'
import { evalFile, sourcesPart } from './eval-source.ts'
import { gatewayPart, harnessPart } from './history/assemble.ts'
import type { FingerprintParts, RunRecord } from './history/types.ts'
import { recordFileName } from './ids.ts'
import type { EvalRecord, Outcome } from './types.ts'
import { gatePart } from './view/gate.ts'

const PARTS: Array<[keyof FingerprintParts, string]> = [
  ['sources', 'eval source'],
  ['harness', 'harness'],
  ['gateway', 'gateway'],
  ['gate', 'gate'],
  ['judge', 'judge'],
]

const listed = (names: string[]) =>
  names.length > 3
    ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
    : names.join(', ')

/**
 * How the plan differs from the run it would retry into, as sentences; none when it's the run's.
 * The run's infra errors it no longer plans and the attempts it plans that the run didn't, then
 * the fingerprint parts that the cell of an attempt it `runs` would get from this plan and its
 * cell in the run doesn't have.
 */
export async function retryChanges(
  previous: RunRecord,
  planned: readonly PlannedItem[],
  runs: ReadonlySet<string>,
  root: string,
  judge: { part: string; model: string | null },
): Promise<string[]> {
  const had = new Map(previous.evals.flatMap((e) => e.attempts.map((a) => [a.key, e] as const)))
  const now = new Map(planned.map((p) => [p.key, p]))
  const changes: string[] = []
  const gone = previous.evals.flatMap((e) =>
    e.attempts.filter((a) => a.outcome === 'infra_error' && !now.has(a.key)).map((a) => a.key),
  )
  if (gone.length) changes.push(`it no longer plans ${listed(gone)}`)
  const added = planned.filter((p) => !p.attempt.plan.skip && !had.has(p.key)).map((p) => p.key)
  if (added.length) changes.push(`it plans ${listed(added)}, which the run didn't`)
  const files = new Map<string, Array<{ path: string; sha256: string }>>()
  const parts = new Map<string, Set<string>>()
  for (const key of runs) {
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
      judge: judge.part,
    }
    for (const [part, name] of PARTS) {
      // With no judge the part still hashes reeval's version, which alone judges nothing.
      if (part === 'judge' && judge.model === null) continue
      if (current[part] === cell.fingerprintParts[part]) continue
      parts.set(name, (parts.get(name) ?? new Set()).add(p.id))
    }
  }
  for (const [name, ids] of parts) changes.push(`the ${name} of ${listed([...ids])} changed`)
  return changes
}

/**
 * The evals whose retried attempts resolved another environment than their cell had in the run:
 * the environment's digest is only known once an attempt resolves it, so this is checked after
 * the retry and before it's written back.
 */
export function retryEnvironmentChanges(
  previous: RunRecord,
  staging: string,
  retried: ReadonlySet<string>,
): string[] {
  const changed = new Set<string>()
  for (const e of previous.evals) {
    for (const a of e.attempts) {
      if (!retried.has(a.key)) continue
      const was = e.cells.find((c) => c.key === a.cell)?.environmentDigest
      if (!was) continue
      let now: string | undefined
      try {
        const text = readFileSync(join(staging, 'evals', recordFileName(a.key)), 'utf8')
        now = (JSON.parse(text) as EvalRecord).environment?.digest
      } catch {
        continue
      }
      if (now && now !== was) changed.add(e.id)
    }
  }
  return [...changed].map((id) => `the environment of ${id} changed`)
}

export type RetryCounts = { retried: number } & Partial<Record<Outcome, number>>

/**
 * How each attempt the run ran again came out, by its outcome in the record. A cancel either
 * aborts an attempt or stops it before it ran again, so it still is the earlier try, with its
 * `startedAt`: both count as not finished (`skipped`), not as an infra error.
 */
export function retryCounts(
  record: RunRecord,
  retried: ReadonlySet<string>,
  previous: RunRecord | null,
): RetryCounts {
  const before = new Map(
    (previous?.evals ?? []).flatMap((e) => e.attempts.map((a) => [a.key, a] as const)),
  )
  const counts: RetryCounts = { retried: 0 }
  for (const a of record.evals.flatMap((e) => e.attempts)) {
    if (!retried.has(a.key)) continue
    counts.retried++
    const was = before.get(a.key)
    const stale =
      a.outcome === 'infra_error' &&
      (a.error?.kind === 'aborted' ||
        (was !== undefined &&
          a.startedAt === was.startedAt &&
          a.error?.message === was.error?.message))
    const outcome = stale ? 'skipped' : a.outcome
    counts[outcome] = (counts[outcome] ?? 0) + 1
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
