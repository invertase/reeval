import { formatDuration } from '../text.ts'
import type { Outcome } from '../types.ts'
import { render } from '../ui/layout.ts'
import { cellsChanged } from '../view/compare.ts'
import type { RunRemarks } from '../view/remarks.ts'
import { isNotGatedPass } from '../view/model.ts'
import { suiteResult } from '../view/suite.ts'
import { warnings } from './state.ts'
import { OUTCOME_MARK, runTally, stateRows } from './summary.ts'
import type { HistoryEntry, RunRecord } from './types.ts'

export {
  type CompareRow,
  compare,
  newRows,
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
    if (!entry) {
      throw new RefError(
        `There ${entries.length === 1 ? 'is only 1 run' : `are only ${entries.length} runs`}, so ${ref} names none. reeval history lists them.`,
      )
    }
    return entry
  }
  const exact = entries.find((e) => e.runId === ref)
  if (exact) return exact
  const byId = entries.filter((e) => e.runId.startsWith(ref))
  if (byId.length === 1 && byId[0]) return byId[0]
  if (byId.length > 1)
    throw new RefError(`"${ref}" matches ${byId.length} runs: use more of the id`)
  if (/^[0-9a-f]{4,40}$/i.test(ref)) {
    const atSha = entries.filter((e) => e.git?.sha.startsWith(ref.toLowerCase()))
    const newest = atSha[atSha.length - 1]
    if (newest) return newest
  }
  throw new RefError(
    `No run matches "${ref}". Pass latest, latest~N, a run id or a git SHA; reeval history lists them.`,
  )
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
  /**
   * Oldest first, one per run; null when the eval wasn't in that run, and `not_gated` for a
   * study's pass, which `pass` and `counted` leave out.
   */
  outcomes: Array<Outcome | 'not_gated' | null>
  /** Indexes into `outcomes` where the eval's fingerprint changed from the previous run. */
  drift: number[]
  pass: number
  counted: number
}

/**
 * Commits reachable from HEAD, holding every run commit a view asks about that is, or null when git
 * can't say (not a repo, shallow clone). Runs whose commit isn't in here were rebased or dropped:
 * still shown and compared, but flagged.
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
        const notGated = e !== undefined && isNotGatedPass(e)
        row.outcomes.push(notGated ? 'not_gated' : (e?.outcome ?? null))
        if (!e) return
        if (cellsChanged(seen, id, e.cells)) row.drift.push(i)
        if (notGated) return
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
      .map(
        (o, i) =>
          `${row.drift.includes(i) ? '¦' : ''}${o === 'not_gated' ? '○' : o ? OUTCOME_MARK[o] : '·'}`,
      )
      .join('')
    const rate = row.counted ? `${row.pass}/${row.counted}` : '–'
    lines.push(`  ${strip.padEnd(width)}  ${rate.padStart(5)}  ${row.id}`)
  }
  lines.push(
    '',
    '✓ pass  ✗ fail  ! infra error  ↓ skipped  ○ not gated  · not run  ¦ eval or stack changed',
  )
  if (orphaned.length > 0) {
    lines.push(
      '',
      `${orphaned.length} run${orphaned.length === 1 ? ' was' : 's were'} recorded on commits that aren't in HEAD's history (rebased or dropped?):`,
      ...orphaned.map((id) => `  ${id}`),
    )
  }
  return lines.join('\n')
}

/** `reeval show`: the run's header and state, then the result blocks `reeval run` ended with. */
export function formatShow(
  run: RunRecord,
  opts: { remarks?: RunRemarks | null } = {},
): string {
  const rows = stateRows(run)
  const width = Math.max(...rows.map(([k]) => k.length))
  return [
    `run ${run.runId}  ${runTally(run)}`,
    `  started ${run.startedAt}  (${formatDuration(run.durationMs)}) · artifacts ${run.artifacts}`,
    '',
    ...rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`),
    ...warnings(run).map((w) => `  ! ${w}`),
    '',
    ...render(suiteResult(run), opts.remarks ?? null, { color: false, verbose: false }),
  ].join('\n')
}
