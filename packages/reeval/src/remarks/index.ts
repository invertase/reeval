// A run's remarks, at the end of `reeval run`: the rules over its record and the history, then,
// with model insights, the model's gated remarks and `no-baseline` on its classification. Each is
// settled against earlier runs' insights: the first run that printed it, its kind's demotion from
// `remark_outcomes`, and the earlier remarks whose cited source this run found changed
// (`actedOn`). Without a model they go in a remarks-only insights.json beside the scratch run,
// which `reeval record` carries into the history.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inCI } from '../env.ts'
import { git } from '../git.ts'
import { comparableFingerprint, type HistoryDb, openHistoryDb } from '../history/db.ts'
import { recordNames, scratchDir } from '../history/files.ts'
import type { EvalEntry, RunRecord } from '../history/types.ts'
import { RUN_ID } from '../ids.ts'
import { insightsFile, readInsights } from '../insights/files.ts'
import { factsHash } from '../insights/hash.ts'
import type { ResolvedConfig } from '../types.ts'
import { NO_MODEL, REMARK_KINDS, type Remark, type RunInsights } from '../view/insights.ts'
import { suiteResult } from '../view/suite.ts'
import { printedIn, type RunRemarks, remarkOutcomes } from './outcomes.ts'
import {
  type Candidate,
  type CheckWindow,
  deterministicRemarks,
  FLAKY_WINDOW,
  noBaseline,
  type RemarkContext,
  rankRemarks,
  remarkId,
} from './rules.ts'

/**
 * The branch the default-branch views count: `origin`'s HEAD, else a local `main` or `master`,
 * else in CI a pull request's base, `GITHUB_BASE_REF`. A GitHub Actions pull request build checks
 * out the merge commit with neither ref; a push build of `main` or `master` checks it out locally.
 */
export async function defaultBranch(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const head = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (head.code === 0) {
    const ref = head.stdout.toString('utf8').trim()
    if (ref) return ref.replace(/^origin\//, '')
  }
  for (const name of ['main', 'master']) {
    const r = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    if (r.code === 0) return name
  }
  return (inCI(env) && env.GITHUB_BASE_REF) || null
}

/** The ids of every run but `runId`, recorded and scratch, with the folder each is in. */
async function otherRuns(config: ResolvedConfig, runId: string) {
  const out: Array<{ dir: string; runId: string }> = []
  const seen = new Set<string>()
  for (const dir of [config.history.dir, scratchDir(config.root)]) {
    for (const name of (await recordNames(dir).catch(() => null)) ?? []) {
      const id = name.slice(0, -5)
      if (!RUN_ID.test(id) || id === runId || seen.has(id)) continue
      seen.add(id)
      out.push({ dir, runId: id })
    }
  }
  return out
}

/** Each run's remarks, from its insights.json; a run without one has none. */
async function remarksIn(runs: Array<{ dir: string; runId: string }>): Promise<RunRemarks[]> {
  const out: RunRemarks[] = []
  for (const run of runs) {
    const doc = await readInsights(insightsFile(run.dir, run.runId)).catch(() => null)
    if (doc?.remarks.length) out.push({ runId: run.runId, remarks: doc.remarks })
  }
  return out
}

/**
 * Each remark id an earlier run printed, with the first run that did. A run's `firstSeenRun` is a
 * run that printed it, unless that run is itself and `printed` is false: the cap or a run without
 * `-v` hid it.
 */
function printedBefore(runs: RunRemarks[]) {
  const first = new Map<string, string>()
  for (const run of runs) {
    for (const r of run.remarks) {
      if (r.actedOn || (r.printed === false && r.firstSeenRun === run.runId)) continue
      const was = first.get(r.id)
      if (!was || r.firstSeenRun < was) first.set(r.id, r.firstSeenRun)
    }
  }
  return first
}

/** A remark as raised, before it's settled: its kind's severity, and no run-specific marks. */
export function candidateOf(r: Remark): Candidate {
  const { firstSeenRun: _, printed: __, actedOn: ___, demoted: ____, ...rest } = r
  return { ...rest, severity: REMARK_KINDS[r.kind].severity }
}

/** `source:<file>#L<n>` → the file. */
const fileOf = (at: string) => at.replace(/^source:/, '').replace(/#L\d+$/, '')

/**
 * The remarks earlier runs printed whose cited source this run finds changed: the quote is gone
 * from its file, or, for a remark without one, the eval's sources changed (its id for this run's
 * sources isn't its own) and this run doesn't raise its kind on that eval again. Only evals this
 * run ran are checked; one already acted on, or raised again by this run, isn't. `slow-mcp-start`
 * is about the environment, so no edit acts on it.
 */
async function actedOn(
  root: string,
  record: RunRecord,
  before: RunRemarks[],
  raised: Remark[],
): Promise<Remark[]> {
  const ids = new Set(raised.map((r) => r.id))
  const kinds = new Set(raised.map((r) => `${r.kind}\0${r.evalId}`))
  const done = new Set(before.flatMap((d) => d.remarks.filter((r) => r.actedOn).map((r) => r.id)))
  const printed = new Map<string, Remark>()
  for (const run of before) {
    for (const r of run.remarks) {
      if (r.kind === 'slow-mcp-start' || r.actedOn || !printedIn(r, run.runId)) continue
      if (!printed.has(r.id)) printed.set(r.id, r)
    }
  }
  const byId = new Map(record.evals.map((e) => [e.id, e]))
  const entries = new Map(
    suiteResult(record).files.flatMap((f) =>
      f.evals.map((e) => [
        e.path,
        (e.cases ? e.cases.map((k) => k.id) : [e.id]).flatMap((id) => byId.get(id) ?? []),
      ]),
    ),
  )
  const texts = new Map<string, Promise<string | null>>()
  const text = (path: string) => {
    let t = texts.get(path)
    if (!t) {
      t = readFile(join(root, path), 'utf8').catch(() => null)
      texts.set(path, t)
    }
    return t
  }
  const out: Remark[] = []
  for (const r of printed.values()) {
    const own = entries.get(r.evalId)
    if (done.has(r.id) || ids.has(r.id) || !own?.length) continue
    const changed = r.source?.quote
      ? !(await text(fileOf(r.source.at)))?.includes(r.source.quote)
      : !kinds.has(`${r.kind}\0${r.evalId}`) &&
        !own.some((entry) => remarkId(r.kind, r.evalId, entry) === r.id)
    if (changed) out.push({ ...r, printed: false, actedOn: { run: record.runId } })
  }
  return out
}

/**
 * The run's remarks from what it raised: each with the first run that printed it, demoted as its
 * kind's `remark_outcomes` says, ranked, then the earlier remarks this run found acted on.
 */
export async function settleRemarks(
  config: ResolvedConfig,
  record: RunRecord,
  candidates: Candidate[],
): Promise<Remark[]> {
  const runs = await remarksIn(await otherRuns(config, record.runId))
  const before = runs.filter((r) => r.runId < record.runId)
  const first = printedBefore(runs)
  const status = new Map(remarkOutcomes(before).map((o) => [o.kind, o.status]))
  const seen = new Set<string>()
  const settled = rankRemarks(
    candidates.flatMap((c): Remark[] => {
      if (seen.has(c.id)) return []
      seen.add(c.id)
      const r = candidateOf({ ...c, firstSeenRun: '' })
      const was = first.get(r.id)
      const firstSeenRun = was && was < record.runId ? was : record.runId
      const kind = status.get(r.kind)
      const demoted =
        kind === 'hidden'
          ? 'hidden'
          : kind === 'demoted' && r.severity === 'concern'
            ? 'suggestion'
            : null
      return [
        demoted ? { ...r, severity: 'suggestion', demoted, firstSeenRun } : { ...r, firstSeenRun },
      ]
    }),
  )
  return [...settled, ...(await actedOn(config.root, record, before, settled))]
}

const one = <T>(db: HistoryDb, sql: string, params: Array<string>) =>
  (db.query(sql, params).rows[0] as T | undefined) ?? null

function historyOf(db: HistoryDb, branch: string | null): NonNullable<RemarkContext['history']> {
  return {
    streak: (evalKey, cellKey, label, fingerprint) =>
      branch === null
        ? null
        : one<{ runs: number; tries: number }>(
            db,
            `SELECT streak_runs AS runs, streak_tries AS tries FROM check_streaks
             WHERE eval_key = ? AND cell_key = ? AND label = ? AND fingerprint = ? AND branch = ?`,
            [evalKey, cellKey, label, fingerprint, branch],
          ),
    flaky: (evalKey, cellKey, fingerprint) =>
      one<{ cause: string }>(
        db,
        `SELECT cause FROM flaky_cells
         WHERE eval_key = ? AND cell_key = ? AND fingerprint = ? AND verdict = 'flaky'`,
        [evalKey, cellKey, fingerprint],
      ),
    window: (evalKey, cellKey, label, fingerprint) => {
      const rows = db.query(
        `SELECT k.pass, k.fail FROM cell_checks k
         JOIN cells c ON c.run_id = k.run_id AND c.eval_key = k.eval_key AND c.key = k.cell_key
         WHERE k.eval_key = ? AND k.cell_key = ? AND k.label = ? AND c.comparable = ?
         ORDER BY k.run_id DESC LIMIT ${FLAKY_WINDOW}`,
        [evalKey, cellKey, label, fingerprint],
      ).rows as Array<{ pass: number; fail: number }>
      return rows.reduce<CheckWindow>(
        (w, r) => ({
          runs: w.runs + 1,
          mixed: w.mixed + (r.pass > 0 && r.fail > 0 ? 1 : 0),
          pass: w.pass + r.pass,
          fail: w.fail + r.fail,
        }),
        { runs: 0, mixed: 0, pass: 0, fail: 0 },
      )
    },
  }
}

/**
 * Finds where a remark's fix goes: the first line naming `needle` from the eval's own declaration
 * on, so another eval in the same file using that label doesn't take it, then anywhere in its
 * sources.
 */
function locator(root: string) {
  const files = new Map<string, Promise<string | null>>()
  const text = (path: string) => {
    let f = files.get(path)
    if (!f) {
      f = readFile(join(root, path), 'utf8').catch(() => null)
      files.set(path, f)
    }
    return f
  }
  const found = new Map<string, string>()
  return {
    async prepare(entry: EvalEntry, needles: Array<string | null>) {
      const quoted = (s: string) => [`'${s}'`, `"${s}"`, `\`${s}\``]
      const lines = async (path: string) => (await text(path))?.split('\n') ?? []
      const own = await lines(entry.file)
      const name = quoted(entry.family?.name ?? entry.name)
      const declared = Math.max(
        0,
        own.findIndex((line) => name.some((w) => line.includes(w))),
      )
      const scans: Array<{ path: string; from: number }> = [
        { path: entry.file, from: declared },
        { path: entry.file, from: 0 },
        ...entry.sources
          .filter((s) => s.path !== entry.file)
          .map((s) => ({ path: s.path, from: 0 })),
      ]
      for (const needle of needles) {
        const key = `${entry.id}\0${needle ?? ''}`
        if (found.has(key)) continue
        // Best first: an object key (`docs: mcp.stdio(…)`), then a string, then the bare word.
        const tiers =
          needle === null
            ? [name]
            : [[`${needle}:`, ...quoted(needle).map((q) => `${q}:`)], quoted(needle), [needle]]
        let at = `source:${entry.file}`
        search: for (const wanted of tiers) {
          for (const { path, from } of needle === null ? scans.slice(1, 2) : scans) {
            for (const [i, line] of (await lines(path)).entries()) {
              if (i >= from && wanted.some((w) => line.includes(w))) {
                at = `source:${path}#L${i + 1}`
                break search
              }
            }
          }
        }
        found.set(key, at)
      }
    },
    locate: (entry: EvalEntry, needle: string | null) =>
      found.get(`${entry.id}\0${needle ?? ''}`) ?? `source:${entry.file}`,
  }
}

/** What the rules may look up in an eval's source: its name, check labels and MCP servers. */
function needlesOf(entry: EvalEntry): Array<string | null> {
  const labels = entry.cells.flatMap((c) => (c.checks ?? []).map((k) => k.label))
  const servers = entry.attempts.flatMap((a) =>
    a.turns.flatMap((t) => (t.mcpStartup ?? []).map((m) => m.server.split(':')[0] as string)),
  )
  return [null, ...new Set([...labels, ...servers])]
}

/** The run's remarks, each with the run that first printed it. History-based kinds need an earlier run. */
export async function remarksOf(config: ResolvedConfig, record: RunRecord): Promise<Remark[]> {
  const runs = await otherRuns(config, record.runId)
  const db = runs.length ? await openHistoryDb(config.root, config.history.dir) : null
  try {
    const loc = locator(config.root)
    for (const entry of record.evals) await loc.prepare(entry, needlesOf(entry))
    const ctx: RemarkContext = {
      history: db ? historyOf(db, await defaultBranch(config.root)) : null,
      comparable: (entry, cellKey) => {
        const cell = entry.cells.find((c) => c.key === cellKey)
        return cell ? comparableFingerprint(cell, entry.attempts) : ''
      },
      locate: loc.locate,
    }
    const candidates = deterministicRemarks(suiteResult(record), record, ctx)
    db?.close()
    return runs.length || candidates.length ? settleRemarks(config, record, candidates) : []
  } catch (error) {
    db?.close()
    throw error
  }
}

/**
 * The run's remarks once model insights are written: the deterministic ones it already raised
 * (`earlier`), the model's gated remarks and `no-baseline` on the classification, settled together,
 * so the cap and the ranking cover them all.
 */
export async function withModelRemarks(
  config: ResolvedConfig,
  record: RunRecord,
  insights: RunInsights,
  earlier: Remark[],
): Promise<Remark[]> {
  const loc = locator(config.root)
  for (const entry of record.evals) await loc.prepare(entry, [null])
  const ctx: RemarkContext = { history: null, comparable: () => '', locate: loc.locate }
  const classified = noBaseline(suiteResult(record), record, insights.evals, ctx)
  const keep = (r: Remark) => !r.actedOn && r.kind !== 'no-baseline'
  return settleRemarks(config, record, [
    ...earlier.filter((r) => keep(r) && r.origin === 'deterministic').map(candidateOf),
    ...insights.remarks.filter((r) => keep(r) && r.origin === 'model').map(candidateOf),
    ...classified,
  ])
}

/** Insights written without an analysis model, for the run's remarks. */
export function remarksOnly(record: RunRecord, remarks: Remark[]): RunInsights {
  return {
    kind: 'reeval-insights',
    schemaVersion: 1,
    runId: record.runId,
    model: NO_MODEL,
    promptVersion: NO_MODEL,
    factsHash: factsHash(suiteResult(record)),
    createdAt: new Date().toISOString(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    headline: null,
    evals: [],
    remarks,
    validation: { dropped: 0, regenerated: 0 },
  }
}
