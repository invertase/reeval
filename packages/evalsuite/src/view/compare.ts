import type { FingerprintParts, HistoryCell, HistoryEntry, StackSummary } from '../history/types.ts'
import type { Outcome } from '../types.ts'

export type CompareStatus = 'regressed' | 'fixed' | 'same' | 'drift' | 'added' | 'removed' | 'infra'

export type CompareRow = {
  id: string
  status: CompareStatus
  base: Outcome | null
  head: Outcome | null
  /** For `drift`: what changed, e.g. `evals/helpers.ts changed` or `harness config changed`. */
  changes?: string[]
  /**
   * When the runs ran different cells of the eval: the cells only head or only base has. Then
   * `status`, `base` and `head` are over the cells both have.
   */
  cells?: { added: string[]; removed: string[] }
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

type StackCell = Pick<
  HistoryCell,
  'key' | 'harness' | 'environment' | 'environmentDigest' | 'fingerprint' | 'fingerprintParts'
>

/** A run's stack, and its cells when known: the per-cell fields then compare over shared cells. */
export type StackSource = Pick<HistoryEntry, 'stack'> & {
  evals?: ReadonlyArray<{ id: string; cells: readonly StackCell[] }>
}

/** The stack fields that differ by which cells ran, read off each cell. */
const PER_CELL: Partial<Record<keyof StackSummary, (c: StackCell) => string | null>> = {
  imageIds: (c) => c.fingerprintParts.image,
  agentClis: (c) => c.fingerprintParts.agentCli,
  harnesses: (c) => c.harness,
  environments: (c) =>
    `${c.environment}@${(c.environmentDigest ?? '').replace(/^sha256:/, '').slice(0, 12)}`,
}

/** The cells both runs have (same eval, same cell key), as `[base, head]` pairs. */
function sharedCells(base: StackSource, head: StackSource): Array<[StackCell, StackCell]> | null {
  if (![base, head].every((r) => r.evals?.every((e) => Array.isArray(e.cells)))) return null
  if (!base.evals || !head.evals) return null
  const before = new Map(base.evals.map((e) => [e.id, new Map(e.cells.map((c) => [c.key, c]))]))
  return head.evals.flatMap((e) =>
    e.cells.flatMap((c): Array<[StackCell, StackCell]> => {
      const b = before.get(e.id)?.get(c.key)
      return b ? [[b, c]] : []
    }),
  )
}

/**
 * What changed in the stack between two runs. With both runs' cells, images, agent CLIs,
 * harnesses and environments compare over the cells both have, so a run over fewer cells isn't
 * drift. Reported served-judge lists only compare when both have one.
 */
export function stackChanges(base: StackSource, head: StackSource): StackChange[] {
  const shared = sharedCells(base, head)
  const changes: StackChange[] = []
  for (const { field, label, outside } of STACK_FIELDS) {
    const pick = PER_CELL[field]
    const differ = pick && shared ? shared.filter(([x, y]) => pick(x) !== pick(y)) : []
    const over = (side: 0 | 1) =>
      [...new Set(differ.flatMap((pair) => pick?.(pair[side]) ?? []))].sort()
    const b = pick && shared ? over(0) : base.stack[field]
    const h = pick && shared ? over(1) : head.stack[field]
    if (field === 'judgeServed' && (!(b as string[]).length || !(h as string[]).length)) continue
    if (JSON.stringify(b) === JSON.stringify(h)) continue
    changes.push({ field, label, base: show(b), head: show(h), outsideFingerprint: outside })
  }
  return changes
}

/**
 * Whether any of these cells changed fingerprint since `seen` last had it, then records them.
 * A cell `seen` doesn't have yet is new coverage, not a change.
 */
export function cellsChanged(
  seen: Map<string, string>,
  evalId: string,
  cells: ReadonlyArray<Pick<HistoryCell, 'key' | 'fingerprint'>>,
): boolean {
  let changed = false
  for (const c of cells) {
    const key = `${evalId}\0${c.key}`
    const was = seen.get(key)
    if (was !== undefined && was !== c.fingerprint) changed = true
    seen.set(key, c.fingerprint)
  }
  return changed
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

/** An eval's outcome from some of its cells, as the run rolls it up: ungated failures pass. */
function outcomeOf(cells: ReadonlyArray<Pick<HistoryCell, 'gate' | 'outcome'>>): Outcome {
  const outcomes = cells.map((c) =>
    c.gate === 'none' && c.outcome === 'fail' ? 'pass' : c.outcome,
  )
  if (outcomes.includes('fail')) return 'fail'
  if (outcomes.includes('infra_error')) return 'infra_error'
  return outcomes.every((o) => o === 'skipped') ? 'skipped' : 'pass'
}

/**
 * When two runs of an eval differ only in which cells ran (a filtered run, a harness added), its
 * outcome on the cells both have, and the cells only one has. Null when no cell is shared or a
 * shared cell changed.
 */
function sharedScope(b: ComparableEval, h: ComparableEval) {
  const before = new Map(b.cells.map((c) => [c.key, c]))
  const shared = h.cells.filter((c) => before.has(c.key))
  if (!shared.length || shared.some((c) => before.get(c.key)?.fingerprint !== c.fingerprint)) {
    return null
  }
  const keys = new Set(h.cells.map((c) => c.key))
  return {
    base: outcomeOf(shared.map((c) => before.get(c.key) ?? c)),
    head: outcomeOf(shared),
    cells: {
      added: h.cells.filter((c) => !before.has(c.key)).map((c) => c.key),
      removed: b.cells.filter((c) => !keys.has(c.key)).map((c) => c.key),
    },
  }
}

export function compare(base: Comparable, head: Comparable): CompareRow[] {
  const graderChanged = stackChanges(base, head).some((c) => c.outsideFingerprint)
  const ids = [...new Set([...head.evals.map((e) => e.id), ...base.evals.map((e) => e.id)])]
  return ids.map((id) => {
    const b = base.evals.find((e) => e.id === id)
    const h = head.evals.find((e) => e.id === id)
    if (!b) return { id, base: null, head: h?.outcome ?? null, status: 'added' }
    if (!h) return { id, base: b.outcome, head: null, status: 'removed' }
    const scoped = b.fingerprint === h.fingerprint ? null : sharedScope(b, h)
    const row: Omit<CompareRow, 'status'> = scoped
      ? { id, ...scoped }
      : { id, base: b.outcome, head: h.outcome }
    if (row.base === 'infra_error' || row.head === 'infra_error') return { ...row, status: 'infra' }
    if (b.fingerprint !== h.fingerprint && !scoped) {
      return { ...row, status: 'drift', changes: whyChanged(b, h) }
    }
    if (graderChanged && row.base !== row.head) return { ...row, status: 'drift' }
    if (row.base === 'pass' && row.head === 'fail') return { ...row, status: 'regressed' }
    if (row.base === 'fail' && row.head === 'pass') return { ...row, status: 'fixed' }
    return { ...row, status: 'same' }
  })
}
