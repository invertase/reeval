import type { FingerprintParts, HistoryEntry, StackSummary } from '../history/types.ts'
import type { Outcome } from '../types.ts'

export type CompareStatus = 'regressed' | 'fixed' | 'same' | 'drift' | 'added' | 'removed' | 'infra'

export type CompareRow = {
  id: string
  status: CompareStatus
  base: Outcome | null
  head: Outcome | null
  /** For `drift`: what changed, e.g. `evals/helpers.ts changed` or `harness config changed`. */
  changes?: string[]
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
  { field: 'judgeVersion', label: 'judge version', outside: false },
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

type ComparableEval = Pick<
  HistoryEntry['evals'][number],
  'id' | 'fingerprint' | 'outcome' | 'sources' | 'cells'
>

type Comparable = Pick<HistoryEntry, 'stack'> & { evals: ComparableEval[] }

/** Which source files were added, removed or changed. */
export function sourceChanges(
  before: ComparableEval['sources'],
  after: ComparableEval['sources'],
): string[] {
  const a = new Map(before.map((s) => [s.path, s.sha256]))
  const b = new Map(after.map((s) => [s.path, s.sha256]))
  return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap((path) => {
    if (!a.has(path)) return [`${path} added`]
    if (!b.has(path)) return [`${path} removed`]
    return a.get(path) === b.get(path) ? [] : [`${path} changed`]
  })
}

const PART_LABELS: Record<Exclude<keyof FingerprintParts, 'sources'>, string> = {
  harness: 'harness config',
  environment: 'environment',
  image: 'image',
  agentCli: 'agent CLI',
  judge: 'judge',
  context: 'agent context',
}

/** Why two runs of an eval aren't comparable: the source files and fingerprint parts that differ. */
export function whyChanged(base: ComparableEval, head: ComparableEval): string[] {
  const out = sourceChanges(base.sources, head.sources)
  const keys = [...new Set([...base.cells, ...head.cells].map((c) => c.key))]
  const parts = new Set<string>()
  for (const key of keys) {
    const b = base.cells.find((c) => c.key === key)
    const h = head.cells.find((c) => c.key === key)
    if (!b || !h) {
      out.push(`cell ${key} ${b ? 'removed' : 'added'}`)
      continue
    }
    for (const part of Object.keys(PART_LABELS) as Array<keyof typeof PART_LABELS>) {
      if (b.fingerprintParts[part] !== h.fingerprintParts[part]) parts.add(PART_LABELS[part])
    }
  }
  return [...out, ...[...parts].map((p) => `${p} changed`)]
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
    if (b.fingerprint !== h.fingerprint)
      return { ...row, status: 'drift', changes: whyChanged(b, h) }
    if (graderChanged && b.outcome !== h.outcome) return { ...row, status: 'drift' }
    if (b.outcome === 'pass' && h.outcome === 'fail') return { ...row, status: 'regressed' }
    if (b.outcome === 'fail' && h.outcome === 'pass') return { ...row, status: 'fixed' }
    return { ...row, status: 'same' }
  })
}
