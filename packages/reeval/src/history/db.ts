// `.reeval/history.db`: a gitignored SQLite projection of the run records, for `reeval query`. Nothing in
// it isn't in the configured history folder or `.reeval/runs`; it's rebuilt incrementally from them on
// every query and can be deleted at any time.
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { isRuntimeState } from '../attempt/context.ts'
import { pairTallies } from '../compare/pairs.ts'
import { UsageError } from '../errors.ts'
import { RUN_ID, relativeFile, sha256 } from '../ids.ts'
import { BUILD_ID, ownRequire } from '../root.ts'
import { DERIVED, DERIVED_TABLES, deriveFacts } from './facts.ts'
import { readRecord, recordNames, scratchDir, warnUnreadable } from './files.ts'
import { rowsOf } from './rows.ts'
import { type ClassContext, classifyCall } from './tool-class.ts'
import { toolTarget } from './tool-target.ts'
import type { AttemptRecord, CellRecord, RunRecord } from './types.ts'

export { toolTarget }

/** Bump when the tables or views change: a database from another version is rebuilt. */
const DB_VERSION = 12
/** This build of reeval, like the header cache: another reeval re-derives every row. */
const BUILD = BUILD_ID

export const historyDbPath = (root: string) => join(root, '.reeval', 'history.db')

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
      `reeval query needs Node ${SQLITE_NODE} or later for node:sqlite (this is Node ${process.versions.node}).`,
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
    return ownRequire('node:sqlite')
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
  ci_provider TEXT, ci_url TEXT, pr_number INTEGER, pr_base TEXT, reeval TEXT, judge_model TEXT,
  judge_version TEXT, profile TEXT, evals INTEGER, attempts INTEGER, pass INTEGER, fail INTEGER,
  not_gated INTEGER, infra_error INTEGER, skipped INTEGER
);
CREATE TABLE evals (
  run_id TEXT NOT NULL, key TEXT NOT NULL, id TEXT, slug TEXT, file TEXT, groups TEXT, name TEXT,
  tags TEXT, fingerprint TEXT, outcome TEXT, pass_at_1 REAL, sources TEXT, family_id TEXT,
  case_index INTEGER,
  PRIMARY KEY (run_id, key)
);
-- Each pooled evaluate.each per run: its cases, and each cell's pass@1 over them (the mean of the
-- cases' pass@1).
CREATE TABLE families (
  run_id TEXT NOT NULL, family_id TEXT NOT NULL, file TEXT, groups TEXT, name TEXT,
  cases INTEGER, ran INTEGER, cell_key TEXT NOT NULL, cell_cases INTEGER, pass INTEGER,
  counted INTEGER, pass_at_1 REAL, lo REAL, hi REAL, method TEXT, outcome TEXT,
  PRIMARY KEY (run_id, family_id, cell_key)
);
-- Every compare-question vote: a pair of sides (arms within a harness, harnesses across an arm)
-- on one run, shown in one order (swapped = 1: b first), and the side picked or 'tie'.
CREATE TABLE votes (
  run_id TEXT NOT NULL, eval_key TEXT NOT NULL, question TEXT NOT NULL, cut TEXT, held TEXT,
  pair_run INTEGER, a TEXT, b TEXT, winner TEXT, swapped INTEGER, reason TEXT
);
-- Each pair of sides' head-to-head per question: a pair decides when both orders agree (or one
-- ties); a split is a pair whose orders picked opposite sides, split_first those that picked
-- the side shown first both times.
CREATE TABLE question_pairs_m (
  run_id TEXT NOT NULL, eval_key TEXT NOT NULL, question TEXT NOT NULL, cut TEXT, held TEXT,
  a TEXT, b TEXT, pairs INTEGER, a_wins INTEGER, b_wins INTEGER, ties INTEGER, splits INTEGER,
  splits_first INTEGER
);
CREATE TABLE family_lift_m (
  run_id TEXT NOT NULL, family_id TEXT NOT NULL, name TEXT, harness TEXT, variant TEXT,
  cell_key TEXT, control TEXT,
  pairs INTEGER, variant_pass_at_1 REAL, control_pass_at_1 REAL, discordant_vc INTEGER,
  discordant_cv INTEGER, points REAL, lo REAL, hi REAL, method TEXT, p REAL,
  within_noise INTEGER, verdict TEXT, min_lift REAL, outcome TEXT, tools_ratio REAL,
  tools_p REAL, effort_verdict TEXT, agent_s_ratio REAL, agent_s_p REAL, time_verdict TEXT,
  tokens_ratio REAL, tokens_p REAL, tokens_verdict TEXT
);
CREATE TABLE cells (
  run_id TEXT NOT NULL, eval_key TEXT NOT NULL, key TEXT NOT NULL, role TEXT, variant TEXT,
  harness TEXT, harness_kind TEXT, model TEXT, reasoning_effort TEXT, environment TEXT,
  environment_digest TEXT, sandbox TEXT, gate TEXT, gate_pass_rate REAL, fingerprint TEXT,
  fp_sources TEXT, fp_harness TEXT, fp_environment TEXT, fp_image TEXT, fp_agent_cli TEXT,
  fp_judge TEXT, fp_context TEXT, runs INTEGER, pass INTEGER, fail INTEGER, infra_error INTEGER,
  skipped INTEGER, pass_at_1 REAL, outcome TEXT, lift_vs TEXT, lift_points REAL, lift_lo REAL,
  lift_hi REAL, within_noise INTEGER, min_lift REAL, comparable TEXT,
  PRIMARY KEY (run_id, eval_key, key)
);
CREATE TABLE attempts (
  run_id TEXT NOT NULL, eval_key TEXT NOT NULL, cell_key TEXT NOT NULL, key TEXT NOT NULL,
  id TEXT, n INTEGER, seq INTEGER, started_at TEXT, outcome TEXT, error_kind TEXT,
  error_message TEXT, duration_ms INTEGER, image_id TEXT, turns INTEGER, tools INTEGER,
  file_edits INTEGER, setup_ms INTEGER, agent_ms INTEGER, checks_ms INTEGER, judge_ms INTEGER,
  last_text TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_tokens INTEGER, reasoning_tokens INTEGER, served_model TEXT, oom_kills INTEGER,
  reasoning_effort TEXT, served_reasoning_effort TEXT,
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
-- What the agent could see, by content hash; runtime = 1 for an agent CLI's own session state,
-- declared = 1 for a file the environment declared (its skills' files, rules and config).
CREATE TABLE attempt_context (
  run_id TEXT NOT NULL, attempt_key TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT, runtime INTEGER,
  declared INTEGER
);
-- Every tool call in each attempt's transcript: its line in transcript.jsonl (from 1), target and
-- class (context, dependency, web, verify or workspace: a heuristic, see tool-class.ts).
CREATE TABLE tool_calls (
  run_id TEXT NOT NULL, attempt_key TEXT NOT NULL, line INTEGER NOT NULL, turn INTEGER,
  tool TEXT, target TEXT, ok INTEGER, duration_ms INTEGER, class TEXT
);
-- Each placed file a tool call named (directly or through a glob), by the call's line.
CREATE TABLE context_reads (
  run_id TEXT NOT NULL, attempt_key TEXT NOT NULL, line INTEGER NOT NULL, path TEXT NOT NULL
);
-- Each stdio MCP server start in each attempt's turns (turn from 1): ms from spawning it to its
-- answer to initialize, null when it never answered.
CREATE TABLE mcp_startup (
  run_id TEXT NOT NULL, attempt_key TEXT NOT NULL, turn INTEGER NOT NULL, server TEXT, ms INTEGER
);
-- Every expect / expect.soft matcher call each attempt made, in call order (seq from 1).
CREATE TABLE assertions (
  run_id TEXT NOT NULL, attempt_key TEXT NOT NULL, eval_key TEXT NOT NULL, cell_key TEXT NOT NULL,
  seq INTEGER NOT NULL, label TEXT NOT NULL, labelled INTEGER, matcher TEXT, status TEXT,
  soft INTEGER, message TEXT, duration_ms INTEGER
);
-- Each check (assertion label) per cell over its counted attempts; on a variant, its control's too.
CREATE TABLE cell_checks (
  run_id TEXT NOT NULL, eval_key TEXT NOT NULL, cell_key TEXT NOT NULL, label TEXT NOT NULL,
  pass INTEGER, fail INTEGER, error INTEGER, not_run INTEGER, control_pass INTEGER,
  control_fail INTEGER, control_error INTEGER, control_not_run INTEGER, verdict TEXT
);
${DERIVED_TABLES}
CREATE INDEX assertions_by_attempt ON assertions (run_id, attempt_key);
CREATE INDEX cells_by_eval ON cells (eval_key, key);
CREATE INDEX tool_calls_by_attempt ON tool_calls (run_id, attempt_key);
CREATE INDEX context_by_attempt ON attempt_context (run_id, attempt_key);
CREATE INDEX context_reads_by_attempt ON context_reads (run_id, attempt_key);
CREATE INDEX attempts_by_cell ON attempts (run_id, eval_key, cell_key);
CREATE INDEX env_skills_by_digest ON env_skills (run_id, digest);
`

/** Canned questions about the history, as views to filter. */
const VIEWS = `
-- Variant against control, per harness, per run.
CREATE VIEW lift AS
  SELECT c.run_id, r.started_at, r.branch, c.eval_key, c.harness, c.model, c.variant,
    c.lift_vs AS control, c.pass AS variant_pass, c.pass + c.fail AS variant_counted,
    k.pass AS control_pass, k.pass + k.fail AS control_counted, c.pass_at_1 AS variant_pass_at_1,
    k.pass_at_1 AS control_pass_at_1, c.lift_points AS points,
    c.lift_lo AS lo, c.lift_hi AS hi, c.within_noise, c.min_lift, c.outcome, c.fingerprint
  FROM cells c JOIN runs r USING (run_id)
  JOIN cells k ON k.run_id = c.run_id AND k.eval_key = c.eval_key AND k.key = c.lift_vs
  WHERE c.role = 'variant';

-- Each variant against its control over a pooled evaluate.each's cases, paired by case, per run.
CREATE VIEW family_lift AS
  SELECT f.*, r.started_at, r.branch
  FROM family_lift_m f JOIN runs r USING (run_id);

-- Cells with mixed outcomes, pooled over runs whose fingerprints match once agent runtime state is
-- left out; 'flaky' needs FLAKY_MIN_ATTEMPTS counted attempts, else 'insufficient'.
CREATE VIEW flaky_cells AS SELECT * FROM flaky_m;

-- Each run where a cell's fingerprint differs from its previous run: which parts, which context
-- paths, and noise = 1 when only agent runtime state changed (not a real change).
CREATE VIEW drift AS SELECT * FROM drift_m;

-- Tool calls, agent time and tokens per cell, and a variant's against its control in the same run.
CREATE VIEW effort AS SELECT * FROM effort_m;

-- Each pair of arms (cells a and b) on one harness and sandbox, when an eval has two variants or
-- more: pass@1 lift of a over b, effort with its verdicts and separation, and the checks that
-- tell them apart. A variant against its control is here too; gating stays variant vs control.
CREATE VIEW contrasts AS SELECT * FROM contrasts_m;

-- Each compare question's pairs of sides, head to head: wins when both orders agree, and splits
-- when the order decided. The pooled win rate counts a split as a win for each side.
CREATE VIEW question_pairs AS SELECT * FROM question_pairs_m;

-- What a factor (environment, harness, model) did, by evidence tier: controlled (one run),
-- pooled (comparable runs, and across evals), observed (over time), not_measured (one level).
CREATE VIEW factor_effects AS SELECT * FROM factor_effects_m;

-- Whether each attempt read each skill its environment placed, and at which transcript line.
-- A read is a tool whose target is under skills/<name>/, or a dedicated load
-- (OpenCode skill, Goose load_skill) whose target is the skill name.
CREATE VIEW skill_reads AS
  SELECT a.run_id, a.eval_key, a.cell_key, a.key AS attempt_key, a.id AS attempt_id, c.variant,
    s.name AS skill, s.placement,
    (SELECT MIN(t.line) FROM tool_calls t WHERE t.run_id = a.run_id AND t.attempt_key = a.key
      AND (t.target LIKE '%skills/' || s.name || '/%'
        OR (t.tool IN ('skill', 'Skill', 'load_skill') AND t.target = s.name))) AS read_line,
    (SELECT COUNT(*) FROM tool_calls t WHERE t.run_id = a.run_id AND t.attempt_key = a.key
      AND (t.target LIKE '%skills/' || s.name || '/%'
        OR (t.tool IN ('skill', 'Skill', 'load_skill') AND t.target = s.name))) AS reads
  FROM attempts a
  JOIN cells c ON c.run_id = a.run_id AND c.eval_key = a.eval_key AND c.key = a.cell_key
  JOIN env_skills s ON s.run_id = c.run_id AND s.digest = c.environment_digest;

-- Tool calls per attempt by class: context (a placed skill, rules file or other placed file, a
-- skill load, an MCP tool of the environment), dependency (node_modules, site-packages, vendor,
-- --help), web, verify (a command the eval's checks run, or test/build/lint/tsc) and workspace.
-- A heuristic: shell commands are split into words and exclusions are not counted.
CREATE VIEW context_use AS
  SELECT a.run_id, a.eval_key, a.cell_key, c.environment, a.key AS attempt_key, a.id AS attempt_id,
    t.class, COUNT(*) AS calls, MIN(t.line) AS first_line,
    (SELECT x.target FROM tool_calls x WHERE x.run_id = a.run_id AND x.attempt_key = a.key
      AND x.class = t.class ORDER BY x.line LIMIT 1) AS example
  FROM tool_calls t
  JOIN attempts a ON a.run_id = t.run_id AND a.key = t.attempt_key
  JOIN cells c ON c.run_id = a.run_id AND c.eval_key = a.eval_key AND c.key = a.cell_key
  GROUP BY a.run_id, a.key, t.class;

-- Each file the environment declared (its skills' files, rules), per attempt: how many tool calls
-- named it, directly or through a glob, and the first one's transcript line (null: never read).
CREATE VIEW skill_files AS
  SELECT a.run_id, a.eval_key, a.cell_key, c.environment, a.key AS attempt_key,
    a.id AS attempt_id, x.path,
    (SELECT COUNT(*) FROM context_reads r WHERE r.run_id = a.run_id AND r.attempt_key = a.key
      AND r.path = x.path) AS reads,
    (SELECT MIN(r.line) FROM context_reads r WHERE r.run_id = a.run_id AND r.attempt_key = a.key
      AND r.path = x.path) AS first_line
  FROM attempt_context x
  JOIN attempts a ON a.run_id = x.run_id AND a.key = x.attempt_key
  JOIN cells c ON c.run_id = a.run_id AND c.eval_key = a.eval_key AND c.key = a.cell_key
  WHERE x.declared = 1;

-- Failed attempts and infra errors (an OOM kill among them) with the cell's harness, model, each
-- of its environment's skills and the label of the first check that failed.
CREATE VIEW failing_attempts AS
  SELECT a.run_id, r.started_at, a.eval_key, a.key AS attempt_key, a.cell_key, c.harness,
    c.model, c.environment, s.name AS skill, a.outcome, a.error_kind, a.error_message,
    a.duration_ms, a.oom_kills,
    (SELECT x.label FROM assertions x WHERE x.run_id = a.run_id AND x.attempt_key = a.key
      AND x.status = 'fail' ORDER BY x.seq LIMIT 1) AS first_failed_check
  FROM attempts a JOIN runs r USING (run_id)
  JOIN cells c ON c.run_id = a.run_id AND c.eval_key = a.eval_key AND c.key = a.cell_key
  LEFT JOIN env_skills s ON s.run_id = c.run_id AND s.digest = c.environment_digest
  WHERE a.outcome IN ('fail', 'infra_error');

-- Each check of a variant cell beside its control's: whether it tells them apart.
CREATE VIEW check_discrimination AS
  SELECT k.run_id, k.eval_key, c.harness, c.variant, c.key AS cell_key, k.label,
    k.pass AS variant_pass, k.fail AS variant_fail, k.not_run AS variant_not_run,
    k.control_pass, k.control_fail, k.control_not_run, k.verdict
  FROM cell_checks k
  JOIN cells c ON c.run_id = k.run_id AND c.eval_key = k.eval_key AND c.key = k.cell_key
  WHERE c.role = 'variant' AND k.verdict IS NOT NULL;

-- Each check (expect label) per cell per run, on every cell (control and variant alike), over the
-- cell's counted attempts. rate = pass / (pass + fail): an error (the matcher couldn't answer) and
-- a not-run (a hard expect before it failed) are left out; null when neither passed nor failed.
CREATE VIEW check_rates AS
  SELECT k.run_id, k.eval_key, k.cell_key, c.harness, c.environment, c.role, k.label, k.pass,
    k.fail, k.error, k.not_run, CAST(k.pass AS REAL) / NULLIF(k.pass + k.fail, 0) AS rate
  FROM cell_checks k
  JOIN cells c ON c.run_id = k.run_id AND c.eval_key = k.eval_key AND c.key = k.cell_key;

-- One eval per run: outcome and pass@1, with the branch and pull request.
CREATE VIEW eval_trend AS
  SELECT e.eval_key, r.run_id, r.started_at, r.branch, r.pr_number, r.recorded, e.outcome,
    e.pass_at_1, e.fingerprint
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
  'family_lift',
  'effort',
  'contrasts',
  'question_pairs',
  'factor_effects',
  'skill_reads',
  'context_use',
  'skill_files',
  'flaky_cells',
  'drift',
  'failing_attempts',
  'eval_trend',
  'verdict_flips',
  'check_discrimination',
  'check_rates',
]

const json = (value: unknown) => JSON.stringify(value)

/** The agent CLI's home config, which its harness writes (MCP servers, settings), not the eval. */
const HARNESS_CONFIG = /^~\/.*(^|\/)(config\.(toml|ya?ml|json)|settings(\.local)?\.json|mcp\.json)$/

/**
 * A placed file the environment declared: under one of its skills, or a rules file outside any
 * skills directory. Not an agent CLI's own state or home config, its bundled skills or the
 * adapter's skill index.
 */
const declaredContext = (path: string, skills: string[]) =>
  !isRuntimeState(path) &&
  !path.endsWith('/.ai-sdk-harness-skills.json') &&
  !HARNESS_CONFIG.test(path) &&
  (skills.some((s) => path.includes(`skills/${s}/`)) || !/(^|\/)skills(-[^/]+)?\//.test(path))

/** `attempts.last_text` is the agent's final message, capped: most "why" questions start there. */
export const LAST_TEXT_LIMIT = 2048

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
      target: toolTarget(event.input, String(event.tool ?? '')),
      ok: event.ok !== false,
      durationMs: typeof event.durationMs === 'number' ? event.durationMs : null,
    })
  })
  return calls
}

/** `classifyCall`, but a call its heuristic can't read counts as workspace: one transcript line can't stop the sync. */
function classifyOrWorkspace(
  tool: string,
  target: string,
  ctx: ClassContext,
): ReturnType<typeof classifyCall> {
  try {
    return classifyCall(tool, target, ctx)
  } catch {
    return { class: 'workspace', files: [] }
  }
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
    record.stack.reeval,
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
  const envOf = new Map(record.environments.map((env) => [env.digest, env]))
  for (const e of record.evals) {
    const cellEnv = new Map(e.cells.map((c) => [c.key, c.environmentDigest ?? '']))
    run(
      `INSERT INTO evals VALUES (${Array(14).fill('?').join(', ')})`,
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
      e.family?.id ?? null,
      e.family?.case ?? null,
    )
    for (const c of e.cells) {
      const p = c.fingerprintParts
      run(
        `INSERT INTO cells VALUES (${Array(36).fill('?').join(', ')})`,
        record.runId,
        e.key,
        c.key,
        c.role,
        c.variant ?? null,
        c.harness,
        c.harnessKind,
        c.model,
        c.effort ?? null,
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
      for (const k of c.checks ?? []) {
        run(
          `INSERT INTO cell_checks VALUES (${Array(13).fill('?').join(', ')})`,
          record.runId,
          e.key,
          c.key,
          k.label,
          k.pass,
          k.fail,
          k.error,
          k.notRun,
          k.control?.pass ?? null,
          k.control?.fail ?? null,
          k.control?.error ?? null,
          k.control?.notRun ?? null,
          k.verdict ?? null,
        )
      }
    }
    for (const answer of e.answers ?? []) {
      for (const v of answer.votes) {
        run(
          `INSERT INTO votes VALUES (${Array(11).fill('?').join(', ')})`,
          record.runId,
          e.key,
          answer.question,
          v.cut,
          v.harness ?? v.arm ?? null,
          v.run,
          v.a,
          v.b,
          v.winner,
          v.swapped ? 1 : 0,
          v.reason ?? null,
        )
      }
      for (const t of pairTallies(answer.votes)) {
        run(
          `INSERT INTO question_pairs_m VALUES (${Array(13).fill('?').join(', ')})`,
          record.runId,
          e.key,
          answer.question,
          t.cut,
          t.held,
          t.a,
          t.b,
          t.pairs,
          t.aWins,
          t.bWins,
          t.ties,
          t.splits,
          t.splitsFirst,
        )
      }
    }
    for (const a of e.attempts) {
      run(
        `INSERT INTO attempts VALUES (${Array(30).fill('?').join(', ')})`,
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
        a.error?.resource?.cause === 'oom' ? a.error.resource.kills : 0,
        a.effort ?? null,
        a.servedEffort ?? null,
      )
      const env = envOf.get(cellEnv.get(a.cell) ?? '')
      const skills = env?.skills.map((x) => x.name) ?? []
      for (const c of a.context) {
        run(
          'INSERT INTO attempt_context VALUES (?, ?, ?, ?, ?, ?)',
          record.runId,
          a.key,
          c.path,
          c.sha256,
          isRuntimeState(c.path) ? 1 : 0,
          declaredContext(c.path, skills) ? 1 : 0,
        )
      }
      for (const [i, t] of a.turns.entries()) {
        for (const m of t.mcpStartup ?? []) {
          run(
            'INSERT INTO mcp_startup VALUES (?, ?, ?, ?, ?)',
            record.runId,
            a.key,
            i + 1,
            m.server,
            m.ms,
          )
        }
      }
      for (const [i, x] of (a.assertions ?? []).entries()) {
        run(
          `INSERT INTO assertions VALUES (${Array(12).fill('?').join(', ')})`,
          record.runId,
          a.key,
          e.key,
          a.cell,
          i + 1,
          x.label,
          x.labelled ? 1 : 0,
          x.matcher,
          x.status,
          x.soft ? 1 : 0,
          x.message ?? null,
          x.durationMs ?? null,
        )
      }
      const transcript = transcripts.get(a.key)
      const ctx: ClassContext = {
        skills,
        files: a.context.map((c) => c.path).filter((p) => declaredContext(p, skills)),
        mcp: env?.mcp ?? [],
        verify: a.checks.map((c) => c.command),
      }
      for (const t of transcript ? toolCalls(transcript) : []) {
        const call = classifyOrWorkspace(t.tool, t.target, ctx)
        run(
          'INSERT INTO tool_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          record.runId,
          a.key,
          t.line,
          t.turn,
          t.tool,
          t.target,
          t.ok ? 1 : 0,
          t.durationMs,
          call.class,
        )
        for (const path of call.files) {
          run('INSERT INTO context_reads VALUES (?, ?, ?, ?)', record.runId, a.key, t.line, path)
        }
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
        // `files.artifacts` is an array of PNG refs, not a single FileRef.
        if (ref == null || Array.isArray(ref) || typeof ref.path !== 'string') continue
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
  for (const f of record.families ?? []) {
    for (const r of f.rates) {
      run(
        `INSERT INTO families VALUES (${Array(16).fill('?').join(', ')})`,
        record.runId,
        f.id,
        f.file,
        json(f.group),
        f.name,
        f.cases,
        f.ran,
        r.cell,
        r.cases,
        r.pass,
        r.counted,
        r.rate,
        r.interval.lo,
        r.interval.hi,
        r.interval.method,
        f.outcome,
      )
    }
    for (const l of f.lifts) {
      const e = l.effort
      const cell = record.evals
        .find((x) => x.family?.id === f.id && x.cells.some((c) => c.key === l.variant))
        ?.cells.find((c) => c.key === l.variant)
      run(
        `INSERT INTO family_lift_m VALUES (${Array(30).fill('?').join(', ')})`,
        record.runId,
        f.id,
        f.name,
        cell?.harness ?? null,
        cell?.variant ?? cell?.environment ?? null,
        l.variant,
        l.vs,
        l.pairs,
        l.variantRate,
        l.controlRate,
        l.discordant?.variantOnly ?? null,
        l.discordant?.controlOnly ?? null,
        l.points,
        l.interval.lo,
        l.interval.hi,
        l.interval.method,
        l.p,
        l.withinNoise ? 1 : 0,
        l.verdict,
        l.minLift ?? null,
        l.outcome,
        e?.tools.ratio ?? null,
        e?.tools.p ?? null,
        e?.tools.verdict ?? null,
        e?.agentMs.ratio ?? null,
        e?.agentMs.p ?? null,
        e?.agentMs.verdict ?? null,
        e?.tokens?.ratio ?? null,
        e?.tokens?.p ?? null,
        e?.tokens?.verdict ?? null,
      )
    }
  }
}

const DATA_TABLES = [
  'runs',
  'evals',
  'families',
  'family_lift_m',
  'votes',
  'question_pairs_m',
  'cells',
  'attempts',
  'judgements',
  'environments',
  'env_skills',
  'artifacts',
  'attempt_context',
  'tool_calls',
  'context_reads',
  'mcp_startup',
  'assertions',
  'cell_checks',
]

function removeRun(db: DatabaseSync, runId: string): void {
  for (const table of DATA_TABLES) db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId)
  db.prepare('DELETE FROM files WHERE run_id = ?').run(runId)
}

function freshSchema(db: DatabaseSync): void {
  const objects = rowsOf<{ type: string; name: string }>(
    db.prepare("SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'view')"),
  )
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
    const rows = rowsOf<{
      key: string
      value: string
    }>(db.prepare('SELECT key, value FROM meta'))
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
 * the same run's scratch copy in `.reeval/runs`. Only new, changed or removed files are touched.
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
    rowsOf<{
      run_id: string
      path: string
      size: number
      mtime_ms: number
    }>(db.prepare('SELECT run_id, path, size, mtime_ms FROM files')).map((r) => [r.run_id, r]),
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
      const rel = relativeFile(root, path)
      const had = known.get(runId)
      if (had && had.path === rel && had.size === info.size && had.mtime_ms === info.mtimeMs) {
        continue
      }
      let record: RunRecord
      try {
        record = await readRecord(path)
      } catch (error) {
        warnUnreadable(path, error)
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
  /** Runs one read-only statement, with `params` bound to its `?`s, or by name (`:run`). */
  query(sql: string, params?: SQLInputValue[] | Record<string, SQLInputValue>): QueryResult
  /** Every table and view, with its columns. */
  schema(): Array<{ name: string; type: 'table' | 'view'; columns: string[] }>
  close(): void
}

/** Opens `.reeval/history.db`, synced with the records; statements after this are read-only. */
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
    query(sql, params = []) {
      try {
        const statement = db.prepare(sql)
        const rows = (
          Array.isArray(params) ? statement.all(...params) : statement.all(params)
        ) as Array<Record<string, unknown>>
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
            ? `reeval query is read-only: .reeval/history.db is a projection of the run records (${message})`
            : `reeval query: ${message}`,
        )
      }
    },
    schema() {
      const objects = rowsOf<{ name: string; type: 'table' | 'view' }>(
        db.prepare(
          `SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT IN ('meta', 'files', 'family_lift_m', ${DERIVED.map((d) => `'${d}'`).join(', ')}) AND name NOT LIKE 'sqlite_%' ORDER BY type, name`,
        ),
      )
      return objects.map((o) => ({
        ...o,
        columns: rowsOf<{ name: string }>(db.prepare(`PRAGMA table_info("${o.name}")`)).map(
          (c) => c.name,
        ),
      }))
    },
    close: () => db.close(),
  }
}
