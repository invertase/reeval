// `.es/history.db`: a gitignored SQLite projection of the run records, for `es query`. Nothing in
// it isn't in `evals/.history` or `.es/runs`; it's rebuilt incrementally from them on every query
// and can be deleted at any time.
import { statSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { isRuntimeState } from '../attempt/context.ts'
import { UsageError } from '../errors.ts'
import { RUN_ID, sha256 } from '../ids.ts'
import { DERIVED, DERIVED_TABLES, deriveFacts } from './facts.ts'
import { readRecord, recordNames, scratchDir } from './files.ts'
import type { AttemptRecord, CellRecord, RunRecord } from './types.ts'

/** Bump when the tables or views change: a database from another version is rebuilt. */
const DB_VERSION = 2
/** The mtime of this module, like the header cache: a rebuilt ES re-derives every row. */
const BUILD = statSync(fileURLToPath(import.meta.url)).mtimeMs

export const historyDbPath = (root: string) => join(root, '.es', 'history.db')

/** `node:sqlite` is in Node from 22.13 (package `engines`); before 24 it warns on load. */
export const SQLITE_NODE = '22.13.0'

export function nodeAtLeast(version: string, min = SQLITE_NODE): boolean {
  const [a = 0, b = 0, c = 0] = version.replace(/^v/, '').split('.').map(Number)
  const [x = 0, y = 0, z = 0] = min.split('.').map(Number)
  return a !== x ? a > x : b !== y ? b > y : c >= z
}

function loadSqlite(): typeof import('node:sqlite') {
  if (!nodeAtLeast(process.versions.node)) {
    throw new UsageError(
      `es query needs Node ${SQLITE_NODE} or later for node:sqlite (this is Node ${process.versions.node}).`,
    )
  }
  const emit = process.emitWarning
  // Only this module's "SQLite is an experimental feature" notice; every other warning prints.
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message
    if (/SQLite/.test(text)) return
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
  try {
    return createRequire(import.meta.url)('node:sqlite')
  } finally {
    process.emitWarning = emit
  }
}

const TABLES = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- The record file each run was read from, and its size and mtime when it was.
CREATE TABLE files (run_id TEXT PRIMARY KEY, path TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL);
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, recorded INTEGER NOT NULL, status TEXT, started_at TEXT, ended_at TEXT,
  duration_ms INTEGER, author TEXT, git_sha TEXT, branch TEXT, dirty INTEGER, runner TEXT,
  ci_provider TEXT, ci_url TEXT, pr_number INTEGER, pr_base TEXT, es TEXT, judge_model TEXT,
  judge_version TEXT, profile TEXT, evals INTEGER, attempts INTEGER, pass INTEGER, fail INTEGER,
  not_gated INTEGER, infra_error INTEGER, skipped INTEGER
);
CREATE TABLE evals (
  run_id TEXT NOT NULL, key TEXT NOT NULL, id TEXT, slug TEXT, file TEXT, groups TEXT, name TEXT,
  tags TEXT, fingerprint TEXT, outcome TEXT, pass_rate REAL, sources TEXT,
  PRIMARY KEY (run_id, key)
);
CREATE TABLE cells (
  run_id TEXT NOT NULL, eval_key TEXT NOT NULL, key TEXT NOT NULL, role TEXT, variant TEXT,
  harness TEXT, harness_kind TEXT, model TEXT, environment TEXT, environment_digest TEXT,
  sandbox TEXT, gate TEXT, gate_pass_rate REAL, fingerprint TEXT, fp_sources TEXT,
  fp_harness TEXT, fp_environment TEXT, fp_image TEXT, fp_agent_cli TEXT, fp_judge TEXT,
  fp_context TEXT, runs INTEGER, pass INTEGER, fail INTEGER, infra_error INTEGER,
  skipped INTEGER, pass_rate REAL, outcome TEXT, lift_vs TEXT, lift_points REAL, lift_lo REAL,
  lift_hi REAL, within_noise INTEGER, min_lift REAL, comparable TEXT,
  PRIMARY KEY (run_id, eval_key, key)
);
CREATE TABLE attempts (
  run_id TEXT NOT NULL, eval_key TEXT NOT NULL, cell_key TEXT NOT NULL, key TEXT NOT NULL,
  id TEXT, n INTEGER, seq INTEGER, started_at TEXT, outcome TEXT, error_kind TEXT,
  error_message TEXT, duration_ms INTEGER, image_id TEXT, turns INTEGER, tools INTEGER,
  file_edits INTEGER, setup_ms INTEGER, agent_ms INTEGER, checks_ms INTEGER, judge_ms INTEGER,
  last_text TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_tokens INTEGER, reasoning_tokens INTEGER, served_model TEXT,
  PRIMARY KEY (run_id, key)
);
CREATE TABLE judgements (
  run_id TEXT NOT NULL, attempt_key TEXT NOT NULL, key TEXT NOT NULL, question TEXT,
  verdict TEXT, score REAL, threshold REAL, model TEXT, resolved_model TEXT, input_path TEXT,
  PRIMARY KEY (run_id, attempt_key, key)
);
CREATE TABLE environments (
  run_id TEXT NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL, parent TEXT, overrides TEXT,
  PRIMARY KEY (run_id, digest)
);
CREATE TABLE env_skills (
  run_id TEXT NOT NULL, digest TEXT NOT NULL, name TEXT NOT NULL, source TEXT, commit_sha TEXT,
  sha256 TEXT, placement TEXT
);
CREATE TABLE artifacts (
  run_id TEXT NOT NULL, attempt_key TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL,
  sha256 TEXT, bytes INTEGER
);
-- What the agent could see, by content hash; runtime = 1 for an agent CLI's own session state.
CREATE TABLE attempt_context (
  run_id TEXT NOT NULL, attempt_key TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT, runtime INTEGER
);
-- Every tool call in each attempt's transcript: its line in transcript.jsonl (from 1) and target.
CREATE TABLE tool_calls (
  run_id TEXT NOT NULL, attempt_key TEXT NOT NULL, line INTEGER NOT NULL, turn INTEGER,
  tool TEXT, target TEXT, ok INTEGER, duration_ms INTEGER
);
${DERIVED_TABLES}
CREATE INDEX cells_by_eval ON cells (eval_key, key);
CREATE INDEX tool_calls_by_attempt ON tool_calls (run_id, attempt_key);
CREATE INDEX context_by_attempt ON attempt_context (run_id, attempt_key);
CREATE INDEX attempts_by_cell ON attempts (run_id, eval_key, cell_key);
CREATE INDEX env_skills_by_digest ON env_skills (run_id, digest);
`

/** The canned questions of docs/history-observability-review.md §2, as views to filter. */
const VIEWS = `
-- Variant against control, per harness, per run.
CREATE VIEW lift AS
  SELECT c.run_id, r.started_at, r.branch, c.eval_key, c.harness, c.model, c.variant,
    c.lift_vs AS control, c.pass AS variant_pass, c.pass + c.fail AS variant_counted,
    k.pass AS control_pass, k.pass + k.fail AS control_counted, c.lift_points AS points,
    c.lift_lo AS lo, c.lift_hi AS hi, c.within_noise, c.min_lift, c.outcome, c.fingerprint
  FROM cells c JOIN runs r USING (run_id)
  JOIN cells k ON k.run_id = c.run_id AND k.eval_key = c.eval_key AND k.key = c.lift_vs
  WHERE c.role = 'variant';

-- Cells with mixed outcomes, pooled over runs whose fingerprints match once agent runtime state is
-- left out; 'flaky' needs FLAKY_MIN_ATTEMPTS counted attempts, else 'insufficient'.
CREATE VIEW flaky_cells AS SELECT * FROM flaky_m;

-- Each run where a cell's fingerprint differs from its previous run: which parts, which context
-- paths, and noise = 1 when only agent runtime state changed (not a real change).
CREATE VIEW drift AS SELECT * FROM drift_m;

-- Tool calls and agent time per cell, and a variant's against its control in the same run.
CREATE VIEW effort AS SELECT * FROM effort_m;

-- What a factor (environment, harness, model) did, by evidence tier: controlled (one run),
-- pooled (comparable runs, and across evals), observed (over time), not_measured (one level).
CREATE VIEW factor_effects AS SELECT * FROM factor_effects_m;

-- Whether each attempt read each skill its environment placed, and at which transcript line.
CREATE VIEW skill_reads AS
  SELECT a.run_id, a.eval_key, a.cell_key, a.key AS attempt_key, a.id AS attempt_id, c.variant,
    s.name AS skill, s.placement,
    (SELECT MIN(t.line) FROM tool_calls t WHERE t.run_id = a.run_id AND t.attempt_key = a.key
      AND t.target LIKE '%skills/' || s.name || '/%') AS read_line,
    (SELECT COUNT(*) FROM tool_calls t WHERE t.run_id = a.run_id AND t.attempt_key = a.key
      AND t.target LIKE '%skills/' || s.name || '/%') AS reads
  FROM attempts a
  JOIN cells c ON c.run_id = a.run_id AND c.eval_key = a.eval_key AND c.key = a.cell_key
  JOIN env_skills s ON s.run_id = c.run_id AND s.digest = c.environment_digest;

-- Failed attempts with the cell's harness, model and each of its environment's skills.
CREATE VIEW failing_attempts AS
  SELECT a.run_id, r.started_at, a.eval_key, a.key AS attempt_key, a.cell_key, c.harness,
    c.model, c.environment, s.name AS skill, a.error_kind, a.error_message, a.duration_ms
  FROM attempts a JOIN runs r USING (run_id)
  JOIN cells c ON c.run_id = a.run_id AND c.eval_key = a.eval_key AND c.key = a.cell_key
  LEFT JOIN env_skills s ON s.run_id = c.run_id AND s.digest = c.environment_digest
  WHERE a.outcome = 'fail';

-- One eval per run: outcome and pass rate, with the branch and pull request.
CREATE VIEW eval_trend AS
  SELECT e.eval_key, r.run_id, r.started_at, r.branch, r.pr_number, r.recorded, e.outcome,
    e.pass_rate, e.fingerprint
  FROM (SELECT key AS eval_key, * FROM evals) e JOIN runs r USING (run_id);

-- Each judge question's pass rate per cell per run, where it differs from that cell's last run.
CREATE VIEW verdict_flips AS
  WITH rates AS (
    SELECT j.run_id, a.eval_key, a.cell_key, j.key AS judgement_key, j.question,
      AVG(j.verdict = 'pass') AS pass_rate, COUNT(*) AS n
    FROM judgements j JOIN attempts a ON a.run_id = j.run_id AND a.key = j.attempt_key
    GROUP BY j.run_id, a.eval_key, a.cell_key, j.key
  ), ordered AS (
    SELECT *, LAG(pass_rate) OVER w AS prev_pass_rate, LAG(run_id) OVER w AS prev_run_id
    FROM rates WINDOW w AS (PARTITION BY eval_key, cell_key, judgement_key ORDER BY run_id)
  )
  SELECT run_id, prev_run_id, eval_key, cell_key, judgement_key, question, prev_pass_rate,
    pass_rate, n
  FROM ordered WHERE prev_run_id IS NOT NULL AND pass_rate IS NOT prev_pass_rate;
`

export const VIEW_NAMES = [
  'lift',
  'effort',
  'factor_effects',
  'skill_reads',
  'flaky_cells',
  'drift',
  'failing_attempts',
  'eval_trend',
  'verdict_flips',
]

const json = (value: unknown) => JSON.stringify(value)

/** `attempts.last_text` is the agent's final message, capped: most "why" questions start there. */
export const LAST_TEXT_LIMIT = 2048

/** A tool call's target: its path, pattern, command or URL, else its input, capped. */
function toolTarget(input: unknown): string {
  if (typeof input !== 'object' || input === null) return String(input ?? '').slice(0, 300)
  const i = input as Record<string, unknown>
  for (const key of [
    'path',
    'file_path',
    'filePath',
    'pattern',
    'glob_pattern',
    'command',
    'url',
    'query',
  ]) {
    if (typeof i[key] === 'string') return (i[key] as string).slice(0, 300)
  }
  return JSON.stringify(input).slice(0, 300)
}

export type ToolCall = {
  line: number
  turn: number | null
  tool: string
  target: string
  ok: boolean
  durationMs: number | null
}

/** The tool calls in a transcript.jsonl, numbered by line from 1; lines that aren't JSON are skipped. */
export function toolCalls(transcript: string): ToolCall[] {
  const calls: ToolCall[] = []
  transcript.split('\n').forEach((line, i) => {
    if (!line.trim()) return
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (event?.type !== 'tool') return
    calls.push({
      line: i + 1,
      turn: typeof event.turn === 'number' ? event.turn : null,
      tool: String(event.tool ?? ''),
      target: toolTarget(event.input),
      ok: event.ok !== false,
      durationMs: typeof event.durationMs === 'number' ? event.durationMs : null,
    })
  })
  return calls
}

/**
 * What a cell's results can be pooled on across runs: its fingerprint parts, with the context
 * part replaced by the context files that aren't an agent CLI's own runtime state.
 */
export function comparableFingerprint(cell: CellRecord, attempts: AttemptRecord[]): string {
  const { context: _context, ...parts } = cell.fingerprintParts
  const files = new Map<string, string>()
  for (const a of attempts) {
    if (a.cell !== cell.key) continue
    for (const c of a.context) if (!isRuntimeState(c.path)) files.set(c.path, c.sha256)
  }
  return sha256(json({ parts, context: [...files].sort(([a], [b]) => (a < b ? -1 : 1)) }))
}

function insertRun(
  db: DatabaseSync,
  record: RunRecord,
  recorded: boolean,
  transcripts: Map<string, string>,
): void {
  const run = (sql: string, ...values: SQLInputValue[]) => db.prepare(sql).run(...values)
  const { runner, summary, git } = record
  run(
    `INSERT INTO runs VALUES (${Array(26).fill('?').join(', ')})`,
    record.runId,
    recorded ? 1 : 0,
    record.status,
    record.startedAt,
    record.endedAt,
    record.durationMs,
    record.author,
    git?.sha ?? null,
    git?.branch ?? null,
    git ? (git.dirty ? 1 : 0) : null,
    runner.kind,
    runner.kind === 'ci' ? runner.provider : null,
    runner.kind === 'ci' ? runner.runUrl : null,
    runner.kind === 'ci' ? (runner.pr?.number ?? null) : null,
    runner.kind === 'ci' ? (runner.pr?.baseRef ?? null) : null,
    record.stack.es,
    record.stack.judge.model,
    record.stack.judge.version,
    record.profile?.name ?? null,
    summary.evals,
    summary.attempts,
    summary.pass,
    summary.fail,
    summary.notGated,
    summary.infraError,
    summary.skipped,
  )
  for (const env of record.environments) {
    run(
      'INSERT OR IGNORE INTO environments VALUES (?, ?, ?, ?, ?)',
      record.runId,
      env.name,
      env.digest,
      env.parent,
      json(env.overrides),
    )
    for (const s of env.skills) {
      run(
        'INSERT INTO env_skills VALUES (?, ?, ?, ?, ?, ?, ?)',
        record.runId,
        env.digest,
        s.name,
        s.source,
        s.commit,
        s.sha256,
        s.placement,
      )
    }
  }
  for (const e of record.evals) {
    run(
      `INSERT INTO evals VALUES (${Array(12).fill('?').join(', ')})`,
      record.runId,
      e.key,
      e.id,
      e.slug,
      e.file,
      json(e.group),
      e.name,
      json(e.tags),
      e.fingerprint,
      e.outcome,
      e.passRate,
      json(e.sources),
    )
    for (const c of e.cells) {
      const p = c.fingerprintParts
      run(
        `INSERT INTO cells VALUES (${Array(35).fill('?').join(', ')})`,
        record.runId,
        e.key,
        c.key,
        c.role,
        c.variant ?? null,
        c.harness,
        c.harnessKind,
        c.model,
        c.environment,
        c.environmentDigest,
        c.sandbox,
        typeof c.gate === 'string' ? c.gate : 'passRate',
        typeof c.gate === 'string' ? null : c.gate.passRate,
        c.fingerprint,
        p.sources,
        p.harness,
        p.environment,
        p.image,
        p.agentCli,
        p.judge,
        p.context,
        c.runs,
        c.pass,
        c.fail,
        c.infraError,
        c.skipped,
        c.passRate,
        c.outcome,
        c.lift?.vs ?? null,
        c.lift?.points ?? null,
        c.lift?.interval.lo ?? null,
        c.lift?.interval.hi ?? null,
        c.lift ? (c.lift.withinNoise ? 1 : 0) : null,
        c.lift?.minLift ?? null,
        comparableFingerprint(c, e.attempts),
      )
    }
    for (const a of e.attempts) {
      run(
        `INSERT INTO attempts VALUES (${Array(27).fill('?').join(', ')})`,
        record.runId,
        e.key,
        a.cell,
        a.key,
        a.id,
        a.n,
        a.seq,
        a.startedAt,
        a.outcome,
        a.error?.kind ?? null,
        a.error?.message ?? null,
        a.durationMs,
        a.imageId,
        a.turns.length,
        a.activity.tools,
        a.activity.fileEdits,
        a.timings.setupMs,
        a.timings.agentMs,
        a.timings.checksMs,
        a.timings.judgeMs,
        a.turns.at(-1)?.text.slice(0, LAST_TEXT_LIMIT) ?? null,
        a.usage?.input ?? null,
        a.usage?.output ?? null,
        a.usage?.cacheRead ?? null,
        a.usage?.cacheWrite ?? null,
        a.usage?.reasoning ?? null,
        a.turns.findLast((t) => t.model)?.model ?? null,
      )
      for (const c of a.context) {
        run(
          'INSERT INTO attempt_context VALUES (?, ?, ?, ?, ?)',
          record.runId,
          a.key,
          c.path,
          c.sha256,
          isRuntimeState(c.path) ? 1 : 0,
        )
      }
      const transcript = transcripts.get(a.key)
      for (const t of transcript ? toolCalls(transcript) : []) {
        run(
          'INSERT INTO tool_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          record.runId,
          a.key,
          t.line,
          t.turn,
          t.tool,
          t.target,
          t.ok ? 1 : 0,
          t.durationMs,
        )
      }
      for (const j of a.judgements) {
        run(
          'INSERT OR IGNORE INTO judgements VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          record.runId,
          a.key,
          j.key,
          j.question,
          j.verdict,
          j.score,
          j.threshold,
          j.model,
          j.resolvedModel ?? null,
          a.files.judgeInput?.path ?? null,
        )
      }
      for (const [kind, ref] of Object.entries(a.files)) {
        if (!ref) continue
        run(
          'INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?)',
          record.runId,
          a.key,
          kind,
          ref.path,
          ref.sha256,
          ref.bytes,
        )
      }
      a.checks.forEach((c, i) => {
        if (!c.log) return
        run(
          'INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?)',
          record.runId,
          a.key,
          `check:${i + 1}`,
          c.log.path,
          c.log.sha256,
          c.log.bytes,
        )
      })
    }
  }
}

const DATA_TABLES = [
  'runs',
  'evals',
  'cells',
  'attempts',
  'judgements',
  'environments',
  'env_skills',
  'artifacts',
  'attempt_context',
  'tool_calls',
]

function removeRun(db: DatabaseSync, runId: string): void {
  for (const table of DATA_TABLES) db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId)
  db.prepare('DELETE FROM files WHERE run_id = ?').run(runId)
}

function freshSchema(db: DatabaseSync): void {
  const objects = db
    .prepare("SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'view')")
    .all() as Array<{ type: string; name: string }>
  for (const o of objects) {
    if (o.name.startsWith('sqlite_')) continue
    db.exec(`DROP ${o.type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS "${o.name}"`)
  }
  db.exec(TABLES)
  db.exec(VIEWS)
  db.prepare('INSERT INTO meta VALUES (?, ?), (?, ?)').run(
    'version',
    String(DB_VERSION),
    'build',
    String(BUILD),
  )
}

function current(db: DatabaseSync): boolean {
  try {
    const rows = db.prepare('SELECT key, value FROM meta').all() as Array<{
      key: string
      value: string
    }>
    const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    return meta.version === String(DB_VERSION) && meta.build === String(BUILD)
  } catch {
    return false
  }
}

/** Each attempt's transcript.jsonl, by attempt key, where the run kept it. */
async function readTranscripts(dir: string, record: RunRecord): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const e of record.evals) {
    for (const a of e.attempts) {
      const ref = a.files.transcript
      if (!ref) continue
      const text = await readFile(join(dir, record.runId, ...ref.path.split('/')), 'utf8').catch(
        () => null,
      )
      if (text !== null) out.set(a.key, text)
    }
  }
  return out
}

export type SyncResult = { runs: number; added: number; removed: number; rebuilt: boolean }

/**
 * Brings the projection up to date with the record files: recorded runs in `historyDir` win over
 * the same run's scratch copy in `.es/runs`. Only new, changed or removed files are touched.
 */
async function sync(db: DatabaseSync, root: string, historyDir: string): Promise<SyncResult> {
  const rebuilt = !current(db)
  if (rebuilt) freshSchema(db)
  const wanted = new Map<string, { path: string; recorded: boolean }>()
  for (const [dir, recorded] of [
    [historyDir, true],
    [scratchDir(root), false],
  ] as const) {
    for (const name of (await recordNames(dir)) ?? []) {
      const runId = name.slice(0, -5)
      if (!RUN_ID.test(runId) || wanted.has(runId)) continue
      wanted.set(runId, { path: join(dir, name), recorded })
    }
  }
  const known = new Map(
    (
      db.prepare('SELECT run_id, path, size, mtime_ms FROM files').all() as Array<{
        run_id: string
        path: string
        size: number
        mtime_ms: number
      }>
    ).map((r) => [r.run_id, r]),
  )
  let added = 0
  let removed = 0
  db.exec('BEGIN')
  try {
    for (const runId of known.keys()) {
      if (!wanted.has(runId)) {
        removeRun(db, runId)
        removed++
      }
    }
    for (const [runId, { path, recorded }] of wanted) {
      const info = await stat(path)
      const rel = relative(root, path)
      const had = known.get(runId)
      if (had && had.path === rel && had.size === info.size && had.mtime_ms === info.mtimeMs) {
        continue
      }
      let record: RunRecord
      try {
        record = await readRecord(path)
      } catch {
        continue
      }
      if (had) removeRun(db, runId)
      insertRun(db, record, recorded, await readTranscripts(dirname(path), record))
      db.prepare('INSERT INTO files VALUES (?, ?, ?, ?)').run(runId, rel, info.size, info.mtimeMs)
      added++
    }
    if (added || removed || rebuilt) deriveFacts(db)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { runs: wanted.size, added, removed, rebuilt }
}

export type QueryResult = { columns: string[]; rows: Array<Record<string, unknown>> }

export type HistoryDb = {
  sync: SyncResult
  /** Runs one read-only statement. */
  query(sql: string): QueryResult
  /** Every table and view, with its columns. */
  schema(): Array<{ name: string; type: 'table' | 'view'; columns: string[] }>
  close(): void
}

/** Opens `.es/history.db`, synced with the records; statements after this are read-only. */
export async function openHistoryDb(
  root: string,
  historyDir: string,
  options: { rebuild?: boolean } = {},
): Promise<HistoryDb> {
  const { DatabaseSync } = loadSqlite()
  const path = historyDbPath(root)
  await mkdir(dirname(path), { recursive: true })
  const writer = new DatabaseSync(path)
  let synced: SyncResult
  try {
    writer.exec('PRAGMA busy_timeout = 5000')
    if (options.rebuild) writer.exec('DROP TABLE IF EXISTS meta')
    synced = await sync(writer, root, historyDir)
  } finally {
    writer.close()
  }
  // Queries get their own read-only connection, so no statement (not even a PRAGMA) can write.
  const db = new DatabaseSync(path, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  return {
    sync: synced,
    query(sql) {
      try {
        const statement = db.prepare(sql)
        const rows = statement.all() as Array<Record<string, unknown>>
        // `columns()` is newer than the Node floor; without it, a query with no rows has none.
        const columns =
          typeof statement.columns === 'function'
            ? statement.columns().map((c) => c.name)
            : Object.keys(rows[0] ?? {})
        return { columns, rows }
      } catch (error) {
        const message = (error as Error).message
        throw new UsageError(
          /readonly|read-only/i.test(message)
            ? `es query is read-only: .es/history.db is a projection of the run records (${message})`
            : `es query: ${message}`,
        )
      }
    },
    schema() {
      const objects = db
        .prepare(
          `SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT IN ('meta', 'files', ${DERIVED.map((d) => `'${d}'`).join(', ')}) AND name NOT LIKE 'sqlite_%' ORDER BY type, name`,
        )
        .all() as Array<{ name: string; type: 'table' | 'view' }>
      return objects.map((o) => ({
        ...o,
        columns: (
          db.prepare(`PRAGMA table_info("${o.name}")`).all() as Array<{ name: string }>
        ).map((c) => c.name),
      }))
    },
    close: () => db.close(),
  }
}
