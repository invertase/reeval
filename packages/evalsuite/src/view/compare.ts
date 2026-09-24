import type { HistoryEntry, StackSummary } from '../history/types.ts'
import type { Outcome } from '../types.ts'

export type CompareStatus = 'regressed' | 'fixed' | 'same' | 'drift' | 'added' | 'removed' | 'infra'

export type CompareRow = {
  id: string
  status: CompareStatus
  base: Outcome | null
  head: Outcome | null
}

export type StackChange = {
  field: keyof StackSummary
  label: string
  base: string
  head: string
  /** Not covered by eval fingerprints, so outcome flips across it are drift, not regressions. */
  outsideFingerprint: boolean
}

const STACK_FIELDS: Array<{ field: keyof StackSummary; label: string; outside: boolean }> = [
  { field: 'imageIds', label: 'image ids', outside: false },
  { field: 'agentClis', label: 'agent CLI', outside: false },
  { field: 'harnesses', label: 'harnesses', outside: false },
  { field: 'environments', label: 'environments', outside: false },
  { field: 'judgeModel', label: 'judge model', outside: false },
  { field: 'threshold', label: 'judge threshold', outside: false },
  { field: 'judgeServed', label: 'judge model served', outside: true },
  { field: 'judgeVersion', label: 'judge version', outside: true },
  { field: 'fingerprintScope', label: 'fingerprint scope', outside: true },
]

const show = (value: StackSummary[keyof StackSummary]) =>
  Array.isArray(value)
    ? value.join(', ') || 'none'
    : value === null
      ? 'none'
      : String(value)
          .replace(/^sha256:/, '')
          .slice(0, 24)

/** What changed in the stack between two runs. Reported served-judge lists only compare when both have one. */
export function stackChanges(
  base: Pick<HistoryEntry, 'stack'>,
  head: Pick<HistoryEntry, 'stack'>,
): StackChange[] {
  const changes: StackChange[] = []
  for (const { field, label, outside } of STACK_FIELDS) {
    const b = base.stack[field]
    const h = head.stack[field]
    if (field === 'judgeServed' && (!(b as string[]).length || !(h as string[]).length)) continue
    if (JSON.stringify(b) === JSON.stringify(h)) continue
    changes.push({ field, label, base: show(b), head: show(h), outsideFingerprint: outside })
  }
  return changes
}

type Comparable = Pick<HistoryEntry, 'stack'> & {
  evals: Array<Pick<HistoryEntry['evals'][number], 'id' | 'fingerprint' | 'outcome'>>
}

export function compare(base: Comparable, head: Comparable): CompareRow[] {
  const graderChanged = stackChanges(base, head).some((c) => c.outsideFingerprint)
  const ids = [...new Set([...head.evals.map((e) => e.id), ...base.evals.map((e) => e.id)])]
  return ids.map((id) => {
    const b = base.evals.find((e) => e.id === id)
    const h = head.evals.find((e) => e.id === id)
    const row = { id, base: b?.outcome ?? null, head: h?.outcome ?? null }
    if (!b) return { ...row, status: 'added' }
    if (!h) return { ...row, status: 'removed' }
    if (b.outcome === 'infra_error' || h.outcome === 'infra_error')
      return { ...row, status: 'infra' }
    if (b.fingerprint !== h.fingerprint) return { ...row, status: 'drift' }
    if (graderChanged && b.outcome !== h.outcome) return { ...row, status: 'drift' }
    if (b.outcome === 'pass' && h.outcome === 'fail') return { ...row, status: 'regressed' }
    if (b.outcome === 'fail' && h.outcome === 'pass') return { ...row, status: 'fixed' }
    return { ...row, status: 'same' }
  })
}
