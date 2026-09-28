import { formatDuration } from '../text.ts'
import type { Outcome } from '../types.ts'
import {
  type CompareCell,
  type CompareRow,
  type CompareStatus,
  cellsChanged,
  stackChanges,
} from '../view/compare.ts'
import { effortChangeLabel } from '../view/effort.ts'
import { warnings } from './state.ts'
import { cellCounts, OUTCOME_MARK, repeatsVerdict, stateRows, summaryCounts } from './summary.ts'
import type { HistoryCell, HistoryEntry, RunRecord } from './types.ts'

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
  if (entries.length === 0) throw new RefError('No runs yet. Run reeval run.')
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
 * The run to compare `head` against: a complete, earlier run on the first commit of `ancestry` that
 * has one, newest run first; otherwise the previous complete run by time. `ancestry` is `git
 * rev-list <head's commit>`: head's own commit first, then every ancestor through all parents
 * (merged branches too, not only first parents), newest commit first. Ancestry beats wall-clock
 * time, which can be skewed.
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
      const seen = new Map<string, string>()
      runs.forEach((run, i) => {
        const e = run.evals.find((x) => x.id === id)
        row.outcomes.push(e?.outcome ?? null)
        if (!e) return
        if (cellsChanged(seen, id, e.cells)) row.drift.push(i)
        if (e.outcome === 'pass' || e.outcome === 'fail') row.counted++
        if (e.outcome === 'pass') row.pass++
      })
      return row
    })
  const orphaned = runs.filter((r) => unreachable(r, options.reach ?? null)).map((r) => r.runId)
  return { runs, rows, orphaned }
}

export function formatHistory({ runs, rows, orphaned }: ReturnType<typeof history>): string {
  if (runs.length === 0)
    return 'No recorded runs yet. Run reeval run --record, or reeval record latest.'
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

/**
 * `: evals/helpers.ts changed, harness config changed` for a row that isn't comparable, and
 * ` · cells removed: …` when the runs ran different cells of the eval.
 */
const why = (r: CompareRow) =>
  [
    r.changes?.length ? `: ${r.changes.join(', ')}` : '',
    r.cells?.added.length ? ` · cells added: ${r.cells.added.join(', ')}` : '',
    r.cells?.removed.length ? ` · cells removed: ${r.cells.removed.join(', ')}` : '',
  ].join('')

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
  const esc = (s: string) => s.replace(/\|/g, '\\|')
  const cells = sorted.flatMap((r) => (r.perCell ?? []).map((c) => ({ row: r, cell: c })))
  if (md) {
    return [
      `### reeval: ${head.runId} vs ${base.runId}`,
      '',
      `Base ${describeRun(base, reach)} → head ${describeRun(head, reach)}. ${tally}.`,
      '',
      ...(changes.length ? [`**Stack changed:** ${changeText}.`, ''] : []),
      '| Eval | Base | Head | Change |',
      '|---|---|---|---|',
      ...sorted.map(
        (r) =>
          `| ${esc(r.id)} | ${mark(r.base)} | ${mark(r.head)} | ${STATUS_LABEL[r.status]}${why(r)} |`,
      ),
      '',
      ...(cells.length
        ? [
            '| Eval | Cell | Lift, base → head | Effort, base → head |',
            '|---|---|---|---|',
            ...cells.map(
              ({ row, cell }) =>
                `| ${esc(row.id)} | ${esc(cell.key)} | ${liftChange(cell)} | ${effortChange(cell)} |`,
            ),
            '',
          ]
        : []),
    ].join('\n')
  }
  return [
    `base ${describeRun(base, reach)} → head ${describeRun(head, reach)}`,
    tally,
    ...(changes.length ? [`stack changed: ${changeText}`] : []),
    '',
    ...sorted.flatMap((r) => [
      `  ${mark(r.base)} → ${mark(r.head)}  ${STATUS_LABEL[r.status].padEnd(24)}  ${r.id}${why(r)}`,
      ...(r.perCell ?? []).map(
        (c) =>
          `      ${c.key}  ${[c.base.lift || c.head.lift ? `lift ${liftChange(c)}` : '', effortChange(c)].filter(Boolean).join(' · ')}`,
      ),
    ]),
  ].join('\n')
}

/** `reeval compare` when head has no earlier recorded run: every eval is new. */
export function formatNoBaseline(head: HistoryEntry, rows: CompareRow[], md: boolean): string {
  const failing = rows.filter((r) => r.head === 'fail').length
  const note = `No earlier recorded run to compare ${head.runId} with: every eval is new${failing ? `, and ${failing} fail${failing === 1 ? 's' : ''}` : ''}.`
  const mark = (o: Outcome | null) => (o ? OUTCOME_MARK[o] : '·')
  if (md) {
    return [
      `### reeval: ${head.runId}`,
      '',
      note,
      '',
      '| Eval | Head |',
      '|---|---|',
      ...rows.map((r) => `| ${r.id.replace(/\|/g, '\\|')} | ${mark(r.head)} |`),
      '',
    ].join('\n')
  }
  return [note, '', ...rows.map((r) => `  ${mark(r.head)}  new  ${r.id}`)].join('\n')
}

const liftShort = (l: NonNullable<HistoryCell['lift']> | undefined) =>
  l ? `${signed(l.points)} (${signed(l.lo)}…${signed(l.hi)})${l.withinNoise ? ' noise' : ''}` : '–'
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}`
const liftChange = (c: CompareCell) => `${liftShort(c.base.lift)} → ${liftShort(c.head.lift)}`
const effortChange = (c: CompareCell) =>
  c.base.effort && c.head.effort ? effortChangeLabel(c.base.effort, c.head.effort) : 'effort –'

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
