import { formatDuration } from '../text.ts'
import type { Outcome } from '../types.ts'
import { type CompareRow, type CompareStatus, stackChanges } from '../view/compare.ts'
import { warnings } from './state.ts'
import { cellCounts, OUTCOME_MARK, repeatsVerdict, stateRows, summaryCounts } from './summary.ts'
import type { HistoryEntry, RunRecord } from './types.ts'

export {
  type CompareRow,
  type CompareStatus,
  compare,
  type StackChange,
  stackChanges,
} from '../view/compare.ts'

export class RefError extends Error {
  override name = 'RefError'
}

/**
 * `latest`, `latest~N`, a run id or unique prefix of one, or a git SHA prefix (the newest run
 * at that commit). `entries` are sorted oldest first.
 */
export function resolveRun(entries: HistoryEntry[], ref = 'latest'): HistoryEntry {
  if (entries.length === 0) throw new RefError('No runs yet. Run es run.')
  const back = /^latest(?:~(\d+))?$/.exec(ref)
  if (back) {
    const entry = entries[entries.length - 1 - Number(back[1] ?? 0)]
    if (!entry) throw new RefError(`There are only ${entries.length} runs`)
    return entry
  }
  const exact = entries.find((e) => e.runId === ref)
  if (exact) return exact
  const byId = entries.filter((e) => e.runId.startsWith(ref))
  if (byId.length === 1 && byId[0]) return byId[0]
  if (byId.length > 1)
    throw new RefError(`"${ref}" matches ${byId.length} runs; use more of the id`)
  if (/^[0-9a-f]{4,40}$/i.test(ref)) {
    const atSha = entries.filter((e) => e.git?.sha.startsWith(ref.toLowerCase()))
    const newest = atSha[atSha.length - 1]
    if (newest) return newest
  }
  throw new RefError(`No run matches "${ref}"`)
}

/**
 * The run to compare `head` against: a complete, earlier run on the nearest first-parent
 * ancestor of head's commit (`ancestry[0]` is head's own commit), newest first; otherwise the
 * previous complete run by time. Ancestry beats wall-clock time, which can be skewed.
 */
export function pickBaseline(
  entries: HistoryEntry[],
  head: HistoryEntry,
  ancestry: string[] | null,
): HistoryEntry | null {
  const earlier = entries.filter((e) => e.runId < head.runId && e.status === 'complete')
  if (ancestry && ancestry.length > 0) {
    const rank = new Map(ancestry.map((sha, i) => [sha, i]))
    let best: HistoryEntry | null = null
    let bestRank = Number.POSITIVE_INFINITY
    for (const e of earlier) {
      const r = e.git ? rank.get(e.git.sha) : undefined
      if (r !== undefined && (r < bestRank || (r === bestRank && best && e.runId > best.runId))) {
        best = e
        bestRank = r
      }
    }
    if (best) return best
  }
  return earlier[earlier.length - 1] ?? null
}

const shortSha = (e: HistoryEntry) => (e.git ? e.git.sha.slice(0, 7) : 'no-git')

export type HistoryRow = {
  id: string
  /** Oldest first, one per run; null when the eval wasn't in that run. */
  outcomes: Array<Outcome | null>
  /** Indexes into `outcomes` where the eval's fingerprint changed from the previous run. */
  drift: number[]
  pass: number
  counted: number
}

/**
 * Commits reachable from HEAD, or null when git can't say (not a repo, shallow clone). Runs whose
 * commit isn't in here were rebased or dropped: still shown and compared, but flagged.
 */
export type Reachability = Set<string> | null

export const unreachable = (entry: HistoryEntry, reach: Reachability) =>
  !!reach && !!entry.git && !reach.has(entry.git.sha)

export function history(
  entries: HistoryEntry[],
  options: { filter?: string; limit?: number; reach?: Reachability } = {},
) {
  const runs = entries.slice(-(options.limit ?? 20))
  const ids: string[] = []
  for (const run of [...runs].reverse()) {
    for (const e of run.evals) if (!ids.includes(e.id)) ids.push(e.id)
  }
  const needle = options.filter?.toLowerCase()
  const rows: HistoryRow[] = ids
    .filter((id) => !needle || id.toLowerCase().includes(needle))
    .map((id) => {
      const row: HistoryRow = { id, outcomes: [], drift: [], pass: 0, counted: 0 }
      let fingerprint: string | undefined
      runs.forEach((run, i) => {
        const e = run.evals.find((x) => x.id === id)
        row.outcomes.push(e?.outcome ?? null)
        if (!e) return
        if (fingerprint !== undefined && e.fingerprint !== fingerprint) row.drift.push(i)
        fingerprint = e.fingerprint
        if (e.outcome === 'pass' || e.outcome === 'fail') row.counted++
        if (e.outcome === 'pass') row.pass++
      })
      return row
    })
  const orphaned = runs.filter((r) => unreachable(r, options.reach ?? null)).map((r) => r.runId)
  return { runs, rows, orphaned }
}

export function formatHistory({ runs, rows, orphaned }: ReturnType<typeof history>): string {
  if (runs.length === 0) return 'No recorded runs yet. Run es run --record, or es record latest.'
  const first = runs[0] as HistoryEntry
  const last = runs[runs.length - 1] as HistoryEntry
  const lines = [
    `${runs.length} run${runs.length === 1 ? '' : 's'}, oldest → newest: ${first.runId} (${shortSha(first)}) … ${last.runId} (${shortSha(last)})`,
    '',
  ]
  const width = Math.max(...rows.map((r) => r.outcomes.length + r.drift.length), 0)
  for (const row of rows) {
    const strip = row.outcomes
      .map((o, i) => `${row.drift.includes(i) ? '¦' : ''}${o ? OUTCOME_MARK[o] : '·'}`)
      .join('')
    const rate = row.counted ? `${row.pass}/${row.counted}` : '–'
    lines.push(`  ${strip.padEnd(width)}  ${rate.padStart(5)}  ${row.id}`)
  }
  lines.push('', '✓ pass  ✗ fail  ! infra error  ↓ skipped  · not run  ¦ eval or stack changed')
  if (orphaned.length > 0) {
    lines.push(
      '',
      `${orphaned.length} run${orphaned.length === 1 ? ' was' : 's were'} recorded on commits that aren't in HEAD's history (rebased or dropped?):`,
      ...orphaned.map((id) => `  ${id}`),
    )
  }
  return lines.join('\n')
}

const STATUS_LABEL: Record<CompareStatus, string> = {
  regressed: 'regressed',
  fixed: 'fixed',
  same: 'same',
  drift: 'changed (not comparable)',
  added: 'new',
  removed: 'removed',
  infra: 'infra error',
}

/** `: evals/helpers.ts changed, harness config changed` for a row that isn't comparable. */
const why = (r: CompareRow) => (r.changes?.length ? `: ${r.changes.join(', ')}` : '')

const ORDER: CompareStatus[] = ['regressed', 'fixed', 'drift', 'infra', 'added', 'removed', 'same']

const describeRun = (e: HistoryEntry, reach: Reachability) =>
  `${e.runId} (${shortSha(e)}${e.recorded ? '' : ', not recorded'}${unreachable(e, reach) ? ", commit not in HEAD's history" : ''})`

export function formatCompare(
  base: HistoryEntry,
  head: HistoryEntry,
  rows: CompareRow[],
  md: boolean,
  reach: Reachability = null,
) {
  const sorted = [...rows].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  const mark = (o: Outcome | null) => (o ? OUTCOME_MARK[o] : '·')
  const count = (s: CompareStatus) => rows.filter((r) => r.status === s).length
  const tally = `${count('regressed')} regressed · ${count('fixed')} fixed · ${count('drift')} not comparable · ${count('same')} same`
  const changes = stackChanges(base, head)
  const changeText = changes.map((c) => `${c.label} ${c.base} → ${c.head}`).join('; ')
  if (md) {
    return [
      `### ES: ${head.runId} vs ${base.runId}`,
      '',
      `Base ${describeRun(base, reach)} → head ${describeRun(head, reach)}. ${tally}.`,
      '',
      ...(changes.length ? [`**Stack changed:** ${changeText}.`, ''] : []),
      '| Eval | Base | Head | Change |',
      '|---|---|---|---|',
      ...sorted.map(
        (r) =>
          `| ${r.id.replace(/\|/g, '\\|')} | ${mark(r.base)} | ${mark(r.head)} | ${STATUS_LABEL[r.status]}${why(r)} |`,
      ),
      '',
    ].join('\n')
  }
  return [
    `base ${describeRun(base, reach)} → head ${describeRun(head, reach)}`,
    tally,
    ...(changes.length ? [`stack changed: ${changeText}`] : []),
    '',
    ...sorted.map(
      (r) =>
        `  ${mark(r.base)} → ${mark(r.head)}  ${STATUS_LABEL[r.status].padEnd(24)}  ${r.id}${why(r)}`,
    ),
  ].join('\n')
}

export function formatShow(run: RunRecord): string {
  const rows = stateRows(run)
  const width = Math.max(...rows.map(([k]) => k.length))
  const lines = [
    `run ${run.runId}  ${summaryCounts(run.summary)}${run.status === 'interrupted' ? '  (interrupted)' : ''}`,
    `  started ${run.startedAt}  (${formatDuration(run.durationMs)}) · artifacts ${run.artifacts}`,
    '',
    ...rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`),
    ...warnings(run).map((w) => `  ! ${w}`),
    '',
  ]
  for (const e of run.evals) {
    const single = e.attempts.length === 1
    const first = e.attempts[0]
    lines.push(
      `  ${OUTCOME_MARK[e.outcome]} ${e.id}${single && first ? `  ${formatDuration(first.durationMs)}` : `  ${cellCounts(e)}`}`,
    )
    for (const t of e.attempts) {
      const indent = single ? '      ' : '        '
      if (!single) {
        lines.push(`      ${OUTCOME_MARK[t.outcome]} ${t.id}  ${formatDuration(t.durationMs)}`)
      }
      for (const j of t.judgements) {
        lines.push(
          `${indent}judge ${j.verdict} ${j.score.toFixed(2)} (≥ ${j.threshold})  ${j.question}`,
        )
      }
      if (t.error && !repeatsVerdict(t)) {
        lines.push(`${indent}${t.error.kind}: ${t.error.message.split('\n')[0]}`)
      }
    }
  }
  return lines.join('\n')
}
