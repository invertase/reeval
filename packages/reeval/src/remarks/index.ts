// A run's deterministic remarks, at the end of `reeval run`: the rules over its record and the
// history, each remark's first run from earlier runs' insights, and the remarks-only insights.json
// they're kept in beside the scratch run, which `reeval record` carries into the history.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from '../git.ts'
import { comparableFingerprint, type HistoryDb, openHistoryDb } from '../history/db.ts'
import { recordNames, scratchDir } from '../history/files.ts'
import type { EvalEntry, RunRecord } from '../history/types.ts'
import { RUN_ID } from '../ids.ts'
import { insightsFile, readInsights } from '../insights/files.ts'
import { factsHash } from '../insights/hash.ts'
import type { ResolvedConfig } from '../types.ts'
import { NO_MODEL, type Remark, type RunInsights } from '../view/insights.ts'
import { suiteResult } from '../view/suite.ts'
import {
  type CheckWindow,
  deterministicRemarks,
  FLAKY_WINDOW,
  type RemarkContext,
} from './rules.ts'

/** The branch the default-branch views count: `origin`'s HEAD, else a local `main` or `master`. */
export async function defaultBranch(root: string): Promise<string | null> {
  const head = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (head.code === 0) {
    const ref = head.stdout.toString('utf8').trim()
    if (ref) return ref.replace(/^origin\//, '')
  }
  for (const name of ['main', 'master']) {
    const r = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    if (r.code === 0) return name
  }
  return null
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

/** Each remark id an earlier run raised, with the first run that did. */
async function raisedBefore(runs: Array<{ dir: string; runId: string }>) {
  const first = new Map<string, string>()
  for (const run of runs) {
    const doc = await readInsights(insightsFile(run.dir, run.runId)).catch(() => null)
    for (const r of doc?.remarks ?? []) {
      const was = first.get(r.id)
      if (!was || r.firstSeenRun < was) first.set(r.id, r.firstSeenRun)
    }
  }
  return first
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

/** The run's remarks, each with the run that first raised it. History-based kinds need an earlier run. */
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
    if (!candidates.length) return []
    const before = await raisedBefore(runs)
    return candidates.map((r) => {
      const was = before.get(r.id)
      return { ...r, firstSeenRun: was && was < record.runId ? was : record.runId }
    })
  } finally {
    db?.close()
  }
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
