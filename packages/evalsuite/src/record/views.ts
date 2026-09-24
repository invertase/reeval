import type { Outcome } from '../types.ts'
import { formatMs, OUTCOME_MARK, summaryCounts } from './summary.ts'
import type { IndexEntry, RunRecord } from './types.ts'

export class RefError extends Error {
  override name = 'RefError'
}

/**
 * `latest`, `latest~N`, a run id or unique prefix of one, or a git SHA prefix (the newest run
 * at that commit). `entries` are sorted oldest first.
 */
export function resolveRun(entries: IndexEntry[], ref = 'latest'): IndexEntry {
  if (entries.length === 0) throw new RefError('No runs yet. Run es run, or es pull.')
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
  entries: IndexEntry[],
  head: IndexEntry,
  ancestry: string[] | null,
): IndexEntry | null {
  const earlier = entries.filter((e) => e.runId < head.runId && e.status === 'complete')
  if (ancestry && ancestry.length > 0) {
    const rank = new Map(ancestry.map((sha, i) => [sha, i]))
    let best: IndexEntry | null = null
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

const shortSha = (e: IndexEntry) => (e.git ? e.git.sha.slice(0, 7) : 'no-git')

export type HistoryRow = {
  id: string
  /** Oldest first, one per run; null when the eval wasn't in that run. */
  outcomes: Array<Outcome | null>
  /** Indexes into `outcomes` where the eval's fingerprint changed from the previous run. */
  drift: number[]
  pass: number
  counted: number
}

export function history(entries: IndexEntry[], options: { filter?: string; limit?: number } = {}) {
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
  return { runs, rows }
}

export function formatHistory({ runs, rows }: ReturnType<typeof history>): string {
  if (runs.length === 0) return 'No runs yet. Run es run, or es pull.'
  const first = runs[0] as IndexEntry
  const last = runs[runs.length - 1] as IndexEntry
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
  return lines.join('\n')
}

export type CompareStatus = 'regressed' | 'fixed' | 'same' | 'drift' | 'added' | 'removed' | 'infra'

export type CompareRow = {
  id: string
  status: CompareStatus
  base: Outcome | null
  head: Outcome | null
}

export function compare(base: IndexEntry, head: IndexEntry): CompareRow[] {
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
    if (b.outcome === 'pass' && h.outcome === 'fail') return { ...row, status: 'regressed' }
    if (b.outcome === 'fail' && h.outcome === 'pass') return { ...row, status: 'fixed' }
    return { ...row, status: 'same' }
  })
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

const ORDER: CompareStatus[] = ['regressed', 'fixed', 'drift', 'infra', 'added', 'removed', 'same']

export function formatCompare(base: IndexEntry, head: IndexEntry, rows: CompareRow[], md: boolean) {
  const sorted = [...rows].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  const mark = (o: Outcome | null) => (o ? OUTCOME_MARK[o] : '·')
  const count = (s: CompareStatus) => rows.filter((r) => r.status === s).length
  const tally = `${count('regressed')} regressed · ${count('fixed')} fixed · ${count('drift')} not comparable · ${count('same')} same`
  if (md) {
    return [
      `### ES: ${head.runId} vs ${base.runId}`,
      '',
      `Base \`${shortSha(base)}\` → head \`${shortSha(head)}\`. ${tally}.`,
      '',
      '| Eval | Base | Head | Change |',
      '|---|---|---|---|',
      ...sorted.map(
        (r) =>
          `| ${r.id.replace(/\|/g, '\\|')} | ${mark(r.base)} | ${mark(r.head)} | ${STATUS_LABEL[r.status]} |`,
      ),
      '',
    ].join('\n')
  }
  return [
    `base ${base.runId} (${shortSha(base)}) → head ${head.runId} (${shortSha(head)})`,
    tally,
    '',
    ...sorted.map(
      (r) => `  ${mark(r.base)} → ${mark(r.head)}  ${STATUS_LABEL[r.status].padEnd(24)}  ${r.id}`,
    ),
  ].join('\n')
}

export function formatShow(run: RunRecord): string {
  const git = run.git
  const lines = [
    `run ${run.runId}  ${summaryCounts(run.summary)}${run.status === 'interrupted' ? '  (interrupted)' : ''}`,
    `  started  ${run.startedAt}  (${formatMs(run.durationMs)}, ${run.runner.kind})`,
    `  commit   ${git ? `${git.sha.slice(0, 12)}${git.branch ? ` ${git.branch}` : ''}${git.dirty ? ' dirty' : ''}` : 'not a git repository'}`,
    `  stack    ${run.config.harness}${run.config.model ? `/${run.config.model}` : ''} · ${run.config.sandbox} · judge ${run.config.judgeModel}`,
    '',
  ]
  for (const e of run.evals) {
    const t = e.trials[0]
    lines.push(`  ${OUTCOME_MARK[e.outcome]} ${e.id}${t ? `  ${formatMs(t.durationMs)}` : ''}`)
    for (const j of t?.judgements ?? []) {
      lines.push(`      judge ${j.verdict} ${j.score.toFixed(2)} (≥ ${j.threshold})  ${j.question}`)
    }
    if (t?.error) lines.push(`      ${t.error.kind}: ${t.error.message.split('\n')[0]}`)
  }
  return lines.join('\n')
}
