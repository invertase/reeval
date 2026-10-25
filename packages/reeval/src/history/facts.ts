// The derived facts behind `reeval query effort`, `factor_effects`, `flaky_cells` and `drift`: computed
// in TypeScript after each sync (SQLite has no rank test or Newcombe interval) and materialised in
// `*_m` tables that those views select from. Every verdict here is a fixed rule over the lift
// interval, `within_noise` and an exact rank test, so the analysis step is told, not asked.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { isRuntimeState } from '../attempt/context.ts'
import { containsZero, EFFECT_MIN_COUNTED, liftInterval, median, round3, wilson } from '../stats.ts'
import { totalTokens } from '../usage.ts'
import { checkVerdict, contrastPairs } from '../view/contrasts.ts'
import {
  contrastEffort,
  type EffortContrast,
  type EffortSample,
  type EffortVerdict,
  effortOf,
} from '../view/effort.ts'
import { rowsOf } from './rows.ts'
import { TOOL_CLASSES } from './tool-class.ts'
import type { CheckTally, FingerprintParts } from './types.ts'

/** Counted attempts, pooled over comparable runs, before a cell with mixed outcomes is `flaky`. */
export const FLAKY_MIN_ATTEMPTS = 6
/** A failing verdict this close to its threshold points at the judge, not the agent. */
export const JUDGE_MARGIN = 0.1

export const DERIVED_TABLES = `
CREATE TABLE effort_m (
  run_id TEXT, eval_key TEXT, cell_key TEXT, role TEXT, variant TEXT, harness TEXT,
  environment TEXT, n INTEGER, tools_median REAL, tools_q1 REAL, tools_q3 REAL,
  agent_s_median REAL, agent_s_q1 REAL, agent_s_q3 REAL, file_edits_median REAL,
  tokens_median REAL, tokens_q1 REAL, tokens_q3 REAL,
  control_key TEXT, control_n INTEGER, control_tools_median REAL, control_agent_s_median REAL,
  control_tokens_median REAL,
  tools_ratio REAL, agent_s_ratio REAL, agent_s_delta REAL, tokens_ratio REAL,
  tools_p REAL, agent_s_p REAL, tokens_p REAL,
  separated INTEGER, time_separated INTEGER, tokens_separated INTEGER,
  verdict TEXT, time_verdict TEXT, tokens_verdict TEXT, tokens_note TEXT,
  context_calls_median REAL, dependency_calls_median REAL, web_calls_median REAL,
  verify_calls_median REAL, workspace_calls_median REAL
);
CREATE TABLE contrasts_m (
  run_id TEXT, eval_key TEXT, harness TEXT, sandbox TEXT, a_key TEXT, b_key TEXT,
  a_environment TEXT, b_environment TEXT, a_pass INTEGER, a_counted INTEGER, b_pass INTEGER,
  b_counted INTEGER, points REAL, lo REAL, hi REAL, pass_verdict TEXT,
  a_tools_median REAL, b_tools_median REAL, tools_ratio REAL, tools_p REAL, separated INTEGER,
  verdict TEXT, agent_s_ratio REAL, time_separated INTEGER, time_verdict TEXT,
  tokens_ratio REAL, tokens_separated INTEGER, tokens_verdict TEXT,
  checks INTEGER, discriminating TEXT
);
CREATE TABLE factor_effects_m (
  factor TEXT, level TEXT, baseline TEXT, context TEXT, tier TEXT, run_id TEXT, eval_key TEXT,
  strata INTEGER, runs INTEGER, variant_pass INTEGER, variant_counted INTEGER,
  control_pass INTEGER, control_counted INTEGER, points REAL, lo REAL, hi REAL,
  within_noise INTEGER, pass_verdict TEXT, tools_ratio REAL, tools_ratios TEXT,
  agent_s_ratio REAL, tools_p REAL, consistent INTEGER, separated INTEGER, effort_verdict TEXT,
  tokens_ratio REAL, tokens_p REAL, tokens_verdict TEXT, tokens_note TEXT,
  note TEXT
);
CREATE TABLE flaky_m (
  eval_key TEXT, cell_key TEXT, fingerprint TEXT, runs INTEGER, flaky_runs INTEGER,
  first_seen TEXT, last_seen TEXT, pass INTEGER, counted INTEGER, infra_error INTEGER,
  pass_at_1 REAL, lo REAL, hi REAL, verdict TEXT, cause TEXT, min_attempts INTEGER
);
CREATE TABLE drift_m (
  run_id TEXT, prev_run_id TEXT, eval_key TEXT, cell_key TEXT, changed TEXT,
  changed_paths TEXT, noise INTEGER, real_changed TEXT
);
CREATE TABLE check_streaks_m (
  eval_key TEXT, cell_key TEXT, label TEXT, fingerprint TEXT, branch TEXT, runs INTEGER,
  fails INTEGER, streak_runs INTEGER, streak_tries INTEGER, streak_since TEXT, last_run TEXT,
  ended_by TEXT
);
`

const FAMILY_COLUMNS = [
  'run_id',
  'family_id',
  'harness',
  'variant',
  'pairs',
  'points',
  'lo',
  'hi',
  'within_noise',
  'verdict',
  'tools_ratio',
  'tools_p',
  'effort_verdict',
  'agent_s_ratio',
  'tokens_ratio',
  'tokens_p',
  'tokens_verdict',
] as const

export const DERIVED = [
  'effort_m',
  'contrasts_m',
  'factor_effects_m',
  'flaky_m',
  'drift_m',
  'check_streaks_m',
]

type Cell = {
  run_id: string
  started_at: string
  eval_key: string
  key: string
  role: string
  variant: string | null
  harness: string
  harness_kind: string
  model: string | null
  environment: string
  sandbox: string
  fingerprint: string
  comparable: string
  lift_vs: string | null
  pass: number
  fail: number
  infra_error: number
} & Record<(typeof PARTS)[number][1], string | null>

type Attempt = {
  run_id: string
  eval_key: string
  cell_key: string
  key: string
  outcome: string
  error_kind: string | null
  tools: number
  agent_ms: number
  file_edits: number
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  reasoning_tokens: number | null
}

/** Each fingerprint part's name in `drift.changed` and its `cells` column; every part has one. */
export const PART_COLUMNS = {
  sources: ['sources', 'fp_sources'],
  harness: ['harness', 'fp_harness'],
  environment: ['environment', 'fp_environment'],
  image: ['image', 'fp_image'],
  agentCli: ['agent_cli', 'fp_agent_cli'],
  judge: ['judge', 'fp_judge'],
  context: ['context', 'fp_context'],
  gateway: ['gateway', 'fp_gateway'],
} as const satisfies Record<keyof FingerprintParts, readonly [string, `fp_${string}`]>
const PARTS = Object.values(PART_COLUMNS)

const r4 = (x: number | null) => (x === null ? null : Math.round(x * 10_000) / 10_000)
const s1 = (ms: number) => Math.round(ms / 100) / 10
const cellId = (run: string, evalKey: string, cell: string) => `${run}\0${evalKey}\0${cell}`

type Side = { pass: number; counted: number; samples: EffortSample[] }

/** One contrast: `level` against `baseline` of `factor`, in the same run and eval. */
type Pair = {
  factor: string
  level: string
  baseline: string
  context: string
  run: string
  evalKey: string
  /** Comparable fingerprints of both cells: runs pool only when both match. */
  pool: string
  v: Side
  c: Side
}

type Row = Record<string, SQLInputValue>

function passCols(v: Side, c: Side): Row {
  const lift = liftInterval({ pass: v.pass, n: v.counted }, { pass: c.pass, n: c.counted })
  const noise = containsZero(lift.low, lift.high)
  return {
    variant_pass: v.pass,
    variant_counted: v.counted,
    control_pass: c.pass,
    control_counted: c.counted,
    points: round3(lift.points),
    lo: round3(lift.low),
    hi: round3(lift.high),
    within_noise: noise ? 1 : 0,
    pass_verdict:
      Math.min(v.counted, c.counted) < EFFECT_MIN_COUNTED
        ? 'insufficient'
        : noise
          ? 'noise'
          : 'effect',
  }
}

function tokenCols(e: EffortContrast | null): Row {
  return {
    tokens_ratio: r4(e?.tokensRatio ?? null),
    tokens_p: r4(e?.tokensP ?? null),
    tokens_verdict: e?.tokensVerdict ?? null,
    tokens_note: e?.tokensNote ?? null,
  }
}

function effortCols(e: EffortContrast | null): Row {
  return {
    tools_ratio: r4(e?.toolsRatio ?? null),
    tools_ratios: e?.toolsRatio === null || !e ? null : `×${e.toolsRatio.toFixed(2)}`,
    agent_s_ratio: r4(e?.agentMsRatio ?? null),
    tools_p: r4(e?.toolsP ?? null),
    consistent: e && (e.verdict === 'fewer' || e.verdict === 'more') ? 1 : 0,
    separated: e?.separated ? 1 : 0,
    effort_verdict: e?.verdict ?? null,
    ...tokenCols(e),
  }
}

/** Across strata: an effect when ≥ 2/3 of them show it in the same direction at p < 0.05. */
function pooledEffort(strata: Array<EffortContrast | null>): Row {
  const known = strata.filter((s): s is EffortContrast => s !== null)
  const k = strata.length
  const count = (v: EffortVerdict) => known.filter((s) => s.verdict === v).length
  const needed = Math.ceil((2 * k) / 3)
  let verdict: EffortVerdict = 'noise'
  if (count('fewer') >= needed && count('more') === 0) verdict = 'fewer'
  else if (count('more') >= needed && count('fewer') === 0) verdict = 'more'
  else if (known.length && count('insufficient') === known.length) verdict = 'insufficient'
  const ratios = known.map((s) => s.toolsRatio).filter((r): r is number => r !== null)
  const sorted = [...ratios].sort((a, b) => a - b)
  const mid = sorted.length
    ? sorted.length % 2
      ? (sorted[(sorted.length - 1) / 2] as number)
      : ((sorted[sorted.length / 2 - 1] as number) + (sorted[sorted.length / 2] as number)) / 2
    : null
  return {
    tools_ratio: r4(mid),
    tools_ratios: known
      .map((s) => (s.toolsRatio === null ? '×–' : `×${s.toolsRatio.toFixed(2)}`))
      .join(' / '),
    agent_s_ratio: null,
    tools_p: r4(known.length ? Math.max(...known.map((s) => s.toolsP ?? 1)) : null),
    consistent: verdict === 'fewer' || verdict === 'more' ? count(verdict) : 0,
    separated: known.filter((s) => s.separated).length,
    effort_verdict: verdict,
    ...pooledTokens(known),
  }
}

/**
 * Token verdict over the strata that reported usage. A stratum without token samples is
 * dropped from this pool only — not `insufficient`, and it does not blank tokens on the rest.
 */
function pooledTokens(known: EffortContrast[]): Row {
  const withTokens = known.filter((s) => s.tokensVerdict !== null)
  if (withTokens.length === 0) {
    return { tokens_ratio: null, tokens_p: null, tokens_verdict: null, tokens_note: null }
  }
  const k = withTokens.length
  const count = (v: EffortVerdict) => withTokens.filter((s) => s.tokensVerdict === v).length
  const needed = Math.ceil((2 * k) / 3)
  let verdict: EffortVerdict = 'noise'
  if (count('fewer') >= needed && count('more') === 0) verdict = 'fewer'
  else if (count('more') >= needed && count('fewer') === 0) verdict = 'more'
  else if (count('insufficient') === k) verdict = 'insufficient'
  const ratios = withTokens.map((s) => s.tokensRatio).filter((r): r is number => r !== null)
  const sorted = [...ratios].sort((a, b) => a - b)
  const mid = sorted.length
    ? sorted.length % 2
      ? (sorted[(sorted.length - 1) / 2] as number)
      : ((sorted[sorted.length / 2 - 1] as number) + (sorted[sorted.length / 2] as number)) / 2
    : null
  return {
    tokens_ratio: r4(mid),
    tokens_p: r4(Math.max(...withTokens.map((s) => s.tokensP ?? 1))),
    tokens_verdict: verdict,
    tokens_note:
      known.some((s) => s.tokensNote) || withTokens.length < known.length
        ? 'some cells did not report usage'
        : null,
  }
}

const merge = (sides: Side[]): Side => ({
  pass: sides.reduce((n, s) => n + s.pass, 0),
  counted: sides.reduce((n, s) => n + s.counted, 0),
  samples: sides.flatMap((s) => s.samples),
})

function insertAll(db: DatabaseSync, table: string, rows: Row[]): void {
  if (rows.length === 0) return
  const cols = rowsOf<{ name: string }>(db.prepare(`PRAGMA table_info("${table}")`)).map(
    (c) => c.name,
  )
  const statement = db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  )
  for (const row of rows) statement.run(...cols.map((c) => row[c] ?? null))
}

/** Recomputes every derived table from the projected rows; run inside the sync's transaction. */
export function deriveFacts(db: DatabaseSync): void {
  for (const table of DERIVED) db.exec(`DELETE FROM ${table}`)
  const cells = rowsOf<Cell>(
    db.prepare(
      'SELECT c.*, r.started_at FROM cells c JOIN runs r USING (run_id) ORDER BY c.run_id, c.rowid',
    ),
  )
  const attempts = rowsOf<Attempt>(
    db.prepare(
      `SELECT run_id, eval_key, cell_key, key, outcome, error_kind, tools, agent_ms, file_edits,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
       FROM attempts ORDER BY run_id, rowid`,
    ),
  )
  const nearThreshold = new Set(
    rowsOf<{ run_id: string; attempt_key: string }>(
      db.prepare(
        `SELECT DISTINCT run_id, attempt_key FROM judgements WHERE verdict = 'fail' AND ABS(score - threshold) <= ${JUDGE_MARGIN}`,
      ),
    ).map((r) => `${r.run_id}\0${r.attempt_key}`),
  )
  const diffs = new Map(
    // An empty diff leaves the agent's answer as its only work, which this doesn't compare.
    rowsOf<{ run_id: string; attempt_key: string; sha256: string | null }>(
      db.prepare(
        `SELECT run_id, attempt_key, sha256 FROM artifacts WHERE kind = 'diff' AND bytes > 0`,
      ),
    ).flatMap((r) => (r.sha256 ? [[`${r.run_id}\0${r.attempt_key}`, r.sha256] as const] : [])),
  )
  const samples = new Map<string, EffortSample[]>()
  const byCell = new Map<string, Attempt[]>()
  for (const a of attempts) {
    const id = cellId(a.run_id, a.eval_key, a.cell_key)
    byCell.set(id, [...(byCell.get(id) ?? []), a])
    if (a.outcome !== 'pass' && a.outcome !== 'fail') continue
    const tokens =
      a.input_tokens === null
        ? undefined
        : totalTokens({
            input: a.input_tokens,
            output: a.output_tokens ?? 0,
            cacheRead: a.cache_read_tokens ?? 0,
            cacheWrite: a.cache_write_tokens ?? 0,
            reasoning: a.reasoning_tokens,
          })
    samples.set(id, [
      ...(samples.get(id) ?? []),
      {
        tools: a.tools,
        agentMs: a.agent_ms,
        fileEdits: a.file_edits,
        ...(tokens !== undefined ? { tokens } : {}),
      },
    ])
  }
  const side = (c: Cell): Side => ({
    pass: c.pass,
    counted: c.pass + c.fail,
    samples: samples.get(cellId(c.run_id, c.eval_key, c.key)) ?? [],
  })
  const find = (run: string, evalKey: string, key: string) =>
    cells.find((c) => c.run_id === run && c.eval_key === evalKey && c.key === key)

  // Tool calls by class per counted attempt, for each cell's per-class medians. An attempt counts
  // when its calls were read from its transcript or its record says it made none (a turnless one
  // has no transcript), with 0 for each class it made no calls in; one whose record has calls but
  // whose transcript couldn't be read stays out. Null for a cell with no attempt that counts.
  const classCounts = new Map<string, Map<string, number>>()
  for (const r of rowsOf<{ run_id: string; attempt_key: string; class: string; n: number }>(
    db.prepare(
      'SELECT run_id, attempt_key, class, COUNT(*) AS n FROM tool_calls GROUP BY run_id, attempt_key, class',
    ),
  )) {
    const id = `${r.run_id}\0${r.attempt_key}`
    const m = classCounts.get(id) ?? new Map<string, number>()
    m.set(r.class, r.n)
    classCounts.set(id, m)
  }
  const classMedians = (c: Cell): Row => {
    const counted = (byCell.get(cellId(c.run_id, c.eval_key, c.key)) ?? []).filter(
      (a) => a.outcome === 'pass' || a.outcome === 'fail',
    )
    const known = counted.flatMap((a) => {
      const m = classCounts.get(`${a.run_id}\0${a.key}`)
      return m ? [m] : a.tools === 0 ? [new Map<string, number>()] : []
    })
    return Object.fromEntries(
      TOOL_CLASSES.map((k) => [
        `${k}_calls_median`,
        known.length ? (median(known.map((m) => m.get(k) ?? 0)) ?? null) : null,
      ]),
    )
  }

  // effort: every cell, and a variant against its control in the same run.
  const effortRows: Row[] = cells.map((c) => {
    const own = effortOf(side(c).samples)
    const control = c.lift_vs ? find(c.run_id, c.eval_key, c.lift_vs) : undefined
    const vs = control ? contrastEffort(side(c).samples, side(control).samples) : null
    return {
      run_id: c.run_id,
      eval_key: c.eval_key,
      cell_key: c.key,
      role: c.role,
      variant: c.variant,
      harness: c.harness,
      environment: c.environment,
      n: own?.n ?? 0,
      tools_median: own?.tools.median ?? null,
      tools_q1: own?.tools.q1 ?? null,
      tools_q3: own?.tools.q3 ?? null,
      agent_s_median: own ? s1(own.agentMs.median) : null,
      agent_s_q1: own ? s1(own.agentMs.q1) : null,
      agent_s_q3: own ? s1(own.agentMs.q3) : null,
      file_edits_median: own?.fileEdits ?? null,
      tokens_median: own?.tokens?.median ?? null,
      tokens_q1: own?.tokens?.q1 ?? null,
      tokens_q3: own?.tokens?.q3 ?? null,
      control_key: control?.key ?? null,
      control_n: vs?.control.n ?? null,
      control_tools_median: vs?.control.tools.median ?? null,
      control_agent_s_median: vs ? s1(vs.control.agentMs.median) : null,
      control_tokens_median: vs?.control.tokens?.median ?? null,
      tools_ratio: r4(vs?.toolsRatio ?? null),
      agent_s_ratio: r4(vs?.agentMsRatio ?? null),
      agent_s_delta: vs ? s1(vs.agentMsDelta) : null,
      tokens_ratio: r4(vs?.tokensRatio ?? null),
      tools_p: r4(vs?.toolsP ?? null),
      agent_s_p: r4(vs?.agentMsP ?? null),
      tokens_p: r4(vs?.tokensP ?? null),
      separated: vs ? (vs.separated ? 1 : 0) : null,
      time_separated: vs ? (vs.timeSeparated ? 1 : 0) : null,
      tokens_separated: vs?.tokensSeparated == null ? null : vs.tokensSeparated ? 1 : 0,
      verdict: vs?.verdict ?? null,
      time_verdict: vs?.timeVerdict ?? null,
      tokens_verdict: vs?.tokensVerdict ?? null,
      tokens_note: vs?.tokensNote ?? null,
      ...classMedians(c),
    }
  })
  insertAll(db, 'effort_m', effortRows)

  // contrasts: each pair of arms on one harness and sandbox, when an eval has two variants or more.
  const checkRows = rowsOf<{
    run_id: string
    eval_key: string
    cell_key: string
    label: string
    pass: number
    fail: number
    error: number
    not_run: number
  }>(
    db.prepare(
      'SELECT run_id, eval_key, cell_key, label, pass, fail, error, not_run FROM cell_checks',
    ),
  )
  const checksOf = new Map<string, Map<string, CheckTally>>()
  for (const k of checkRows) {
    const id = cellId(k.run_id, k.eval_key, k.cell_key)
    const m = checksOf.get(id) ?? new Map<string, CheckTally>()
    m.set(k.label, { pass: k.pass, fail: k.fail, error: k.error, notRun: k.not_run })
    checksOf.set(id, m)
  }
  const evalCells = new Map<string, Cell[]>()
  for (const c of cells) {
    const id = `${c.run_id}\0${c.eval_key}`
    evalCells.set(id, [...(evalCells.get(id) ?? []), c])
  }
  const contrastRows: Row[] = []
  for (const group of evalCells.values()) {
    for (const [a, b] of contrastPairs(group)) {
      const x = side(a)
      const y = side(b)
      const e = contrastEffort(x.samples, y.samples)
      const ka = checksOf.get(cellId(a.run_id, a.eval_key, a.key)) ?? new Map<string, CheckTally>()
      const kb = checksOf.get(cellId(b.run_id, b.eval_key, b.key)) ?? new Map<string, CheckTally>()
      const verdicts = [...ka].flatMap(([label, t]) => {
        const other = kb.get(label)
        const verdict = other && checkVerdict(t, other)
        return verdict ? [{ label, verdict }] : []
      })
      const pass = passCols(x, y)
      contrastRows.push({
        run_id: a.run_id,
        eval_key: a.eval_key,
        harness: a.harness,
        sandbox: a.sandbox,
        a_key: a.key,
        b_key: b.key,
        a_environment: a.environment,
        b_environment: b.environment,
        a_pass: x.pass,
        a_counted: x.counted,
        b_pass: y.pass,
        b_counted: y.counted,
        points: pass.points ?? null,
        lo: pass.lo ?? null,
        hi: pass.hi ?? null,
        pass_verdict: pass.pass_verdict ?? null,
        a_tools_median: e?.variant.tools.median ?? null,
        b_tools_median: e?.control.tools.median ?? null,
        tools_ratio: r4(e?.toolsRatio ?? null),
        tools_p: r4(e?.toolsP ?? null),
        separated: e ? (e.separated ? 1 : 0) : null,
        verdict: e?.verdict ?? null,
        agent_s_ratio: r4(e?.agentMsRatio ?? null),
        time_separated: e ? (e.timeSeparated ? 1 : 0) : null,
        time_verdict: e?.timeVerdict ?? null,
        tokens_ratio: r4(e?.tokensRatio ?? null),
        tokens_separated: e?.tokensSeparated == null ? null : e.tokensSeparated ? 1 : 0,
        tokens_verdict: e?.tokensVerdict ?? null,
        checks: verdicts.length,
        discriminating:
          verdicts
            .filter((v) => v.verdict === 'discriminates')
            .map((v) => v.label)
            .join(' · ') || null,
      })
    }
  }
  insertAll(db, 'contrasts_m', contrastRows)

  // Controlled contrasts: a variant against its control, and a harness or model against the
  // eval's first one, on the same environment and sandbox.
  const pairs: Pair[] = []
  const groups = new Map<string, Cell[]>()
  for (const c of cells) {
    const id = `${c.run_id}\0${c.eval_key}`
    groups.set(id, [...(groups.get(id) ?? []), c])
  }
  for (const group of groups.values()) {
    for (const v of group) {
      const control = v.lift_vs ? group.find((c) => c.key === v.lift_vs) : undefined
      if (!control) continue
      pairs.push({
        factor: 'environment',
        level: v.variant ?? v.environment,
        baseline: 'control',
        context: v.harness,
        run: v.run_id,
        evalKey: v.eval_key,
        pool: `${v.comparable}\0${control.comparable}`,
        v: side(v),
        c: side(control),
      })
    }
    const bySetup = new Map<string, Cell[]>()
    for (const c of group) {
      const id = `${c.variant ?? c.role}\0${c.sandbox}`
      bySetup.set(id, [...(bySetup.get(id) ?? []), c])
    }
    for (const same of bySetup.values()) {
      const base = same[0] as Cell
      for (const other of same.slice(1)) {
        if (other.harness === base.harness) continue
        pairs.push({
          factor: other.harness_kind === base.harness_kind ? 'model' : 'harness',
          level: other.harness,
          baseline: base.harness,
          context: other.variant ?? 'control',
          run: other.run_id,
          evalKey: other.eval_key,
          pool: `${other.comparable}\0${base.comparable}`,
          v: side(other),
          c: side(base),
        })
      }
    }
  }
  const factorRows: Row[] = []
  const head = (p: Pick<Pair, 'factor' | 'level' | 'baseline' | 'context'>) => ({
    factor: p.factor,
    level: p.level,
    baseline: p.baseline,
    context: p.context,
  })
  for (const p of pairs) {
    factorRows.push({
      ...head(p),
      tier: 'controlled',
      run_id: p.run,
      eval_key: p.evalKey,
      strata: 1,
      runs: 1,
      ...passCols(p.v, p.c),
      ...effortCols(contrastEffort(p.v.samples, p.c.samples)),
      note: null,
    })
  }
  // Pooled: the same contrast over runs where both cells are comparable, per eval, then across
  // evals with each (eval, comparable runs) group as a stratum. Two source fingerprints of the
  // same eval are not two strata of one contrast: that would straddle an eval-changed pair.
  const pooled = new Map<string, Pair[]>()
  for (const p of pairs) {
    const id = [p.factor, p.level, p.baseline, p.context, p.evalKey, p.pool].join('\0')
    pooled.set(id, [...(pooled.get(id) ?? []), p])
  }
  const strata = new Map<string, Array<{ evalKey: string; pool: string; v: Side; c: Side }>>()
  for (const group of pooled.values()) {
    const first = group[0] as Pair
    const v = merge(group.map((p) => p.v))
    const c = merge(group.map((p) => p.c))
    if (group.length > 1) {
      factorRows.push({
        ...head(first),
        tier: 'pooled',
        run_id: null,
        eval_key: first.evalKey,
        strata: 1,
        runs: group.length,
        ...passCols(v, c),
        ...effortCols(contrastEffort(v.samples, c.samples)),
        note: null,
      })
    }
    const id = [first.factor, first.level, first.baseline, first.context].join('\0')
    strata.set(id, [...(strata.get(id) ?? []), { evalKey: first.evalKey, pool: first.pool, v, c }])
  }
  for (const [id, list] of strata) {
    const poolsByEval = new Map<string, Set<string>>()
    for (const s of list) {
      poolsByEval.set(s.evalKey, new Set([...(poolsByEval.get(s.evalKey) ?? []), s.pool]))
    }
    const comparable = list.filter((s) => (poolsByEval.get(s.evalKey)?.size ?? 0) === 1)
    if (new Set(comparable.map((s) => s.evalKey)).size < 2) continue
    const [factor, level, baseline, context] = id.split('\0') as [string, string, string, string]
    const v = merge(comparable.map((s) => s.v))
    const c = merge(comparable.map((s) => s.c))
    factorRows.push({
      ...head({ factor, level, baseline, context }),
      tier: 'pooled',
      run_id: null,
      eval_key: null,
      strata: comparable.length,
      runs: null,
      ...passCols(v, c),
      ...pooledEffort(comparable.map((s) => contrastEffort(s.v.samples, s.c.samples))),
      note: 'pass@1: summed counts; effort: an effect in at least 2/3 of strata',
    })
  }

  // Paired: a pooled evaluate.each's variant against its control over the cases of one run, each
  // case a paired sample, as its record computed it.
  const familyLifts = rowsOf<Record<(typeof FAMILY_COLUMNS)[number], SQLInputValue>>(
    db.prepare(`SELECT ${FAMILY_COLUMNS.join(', ')} FROM family_lift_m`),
  )
  for (const f of familyLifts) {
    factorRows.push({
      factor: 'environment',
      level: f.variant,
      baseline: 'control',
      context: f.harness,
      tier: 'paired',
      run_id: f.run_id,
      eval_key: f.family_id,
      strata: f.pairs,
      runs: 1,
      points: f.points,
      lo: f.lo,
      hi: f.hi,
      within_noise: f.within_noise,
      pass_verdict:
        f.verdict === 'insufficient' ? 'insufficient' : f.within_noise ? 'noise' : 'effect',
      tools_ratio: f.tools_ratio,
      agent_s_ratio: f.agent_s_ratio,
      tools_p: f.tools_p,
      effort_verdict: f.effort_verdict,
      tokens_ratio: f.tokens_ratio,
      tokens_p: f.tokens_p,
      tokens_verdict: f.tokens_verdict,
      note: 'paired by case over a pooled evaluate.each: strata is the paired cases',
    })
  }

  // drift: a cell's fingerprint against its previous run's, with the context paths that changed.
  const driftRows: Row[] = []
  const series = new Map<string, Cell[]>()
  for (const c of cells) {
    const id = `${c.eval_key}\0${c.key}`
    series.set(id, [...(series.get(id) ?? []), c])
  }
  const contextOf = db.prepare(
    'SELECT path, sha256 FROM attempt_context WHERE run_id = ? AND attempt_key = ?',
  )
  const cellContext = (c: Cell) => {
    const files = new Map<string, string>()
    for (const a of byCell.get(cellId(c.run_id, c.eval_key, c.key)) ?? []) {
      for (const f of rowsOf<{ path: string; sha256: string }>(contextOf, c.run_id, a.key)) {
        files.set(f.path, f.sha256)
      }
    }
    return files
  }
  for (const list of series.values()) {
    list.sort((a, b) => (a.run_id < b.run_id ? -1 : 1))
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1] as Cell
      const cur = list[i] as Cell
      if (prev.fingerprint === cur.fingerprint) continue
      const changed = PARTS.filter(([, col]) => prev[col] !== cur[col]).map(([name]) => name)
      let paths: string[] = []
      if (changed.includes('context')) {
        const a = cellContext(prev)
        const b = cellContext(cur)
        paths = [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort()
      }
      const contextNoise = paths.length > 0 && paths.every(isRuntimeState)
      const real = changed.filter((part) => part !== 'context' || !contextNoise)
      driftRows.push({
        run_id: cur.run_id,
        prev_run_id: prev.run_id,
        eval_key: cur.eval_key,
        cell_key: cur.key,
        changed: changed.join(' '),
        changed_paths: paths.length ? paths.join(', ') : null,
        noise: real.length === 0 ? 1 : 0,
        real_changed: real.join(' ') || null,
      })
      if (real.length === 0) continue
      // Observed over time: what changed between two runs of the same cell.
      const judgeOnly = real.length === 1 && real[0] === 'judge'
      const sourcesChanged = real.includes('sources')
      const cols = passCols(side(cur), side(prev))
      if (sourcesChanged) cols.pass_verdict = 'not_comparable'
      factorRows.push({
        factor: real.length === 1 ? (real[0] as string) : 'confounded',
        level: cur.run_id,
        baseline: prev.run_id,
        context: `${cur.eval_key} # ${cur.key}`,
        tier: 'observed',
        run_id: cur.run_id,
        eval_key: cur.eval_key,
        strata: 1,
        runs: 2,
        ...cols,
        ...effortCols(contrastEffort(side(cur).samples, side(prev).samples)),
        note: sourcesChanged
          ? 'the eval changed: not comparable, not an effect of the thing under test'
          : judgeOnly
            ? 'the judge changed: a measurement change, not an effect of the thing under test'
            : real.length > 1
              ? `confounded: ${real.join(', ')} changed together`
              : null,
      })
    }
  }
  insertAll(db, 'drift_m', driftRows)

  // Factors with one level across every run can't be attributed.
  const levels = (pick: (c: Cell) => string) => [...new Set(cells.map(pick))]
  const single: Array<[string, string[]]> = [
    ['harness', levels((c) => c.harness_kind)],
    ['model', levels((c) => `${c.harness_kind}:${c.model ?? '-'}`)],
    ['sandbox', levels((c) => c.sandbox)],
  ]
  if (cells.length && !cells.some((c) => c.role === 'variant')) {
    single.push(['environment', levels((c) => c.environment)])
  }
  for (const [factor, values] of single) {
    if (values.length !== 1) continue
    factorRows.push({
      factor,
      level: values[0] as string,
      baseline: null,
      context: null,
      tier: 'not_measured',
      note: 'one level in every run, so its effect is not measured',
    })
  }
  insertAll(db, 'factor_effects_m', factorRows)

  // flaky_cells: mixed outcomes pooled over comparable runs.
  const flaky = new Map<string, Cell[]>()
  for (const c of cells) {
    const id = `${c.eval_key}\0${c.key}\0${c.comparable}`
    flaky.set(id, [...(flaky.get(id) ?? []), c])
  }
  const flakyRows: Row[] = []
  for (const list of flaky.values()) {
    const pass = list.reduce((n, c) => n + c.pass, 0)
    const fail = list.reduce((n, c) => n + c.fail, 0)
    if (!(pass > 0 && fail > 0)) continue
    const first = list[0] as Cell
    const infra = list.reduce((n, c) => n + c.infra_error, 0)
    const failing = list.flatMap((c) =>
      (byCell.get(cellId(c.run_id, c.eval_key, c.key)) ?? []).filter((a) => a.outcome === 'fail'),
    )
    const w = wilson(pass, pass + fail)
    const passedDiffs = new Set(
      list.flatMap((c) =>
        (byCell.get(cellId(c.run_id, c.eval_key, c.key)) ?? []).flatMap((a) => {
          const sha = a.outcome === 'pass' && diffs.get(`${a.run_id}\0${a.key}`)
          return sha ? [sha] : []
        }),
      ),
    )
    // The same change both passed and failed its checks: the checks, not the agent, vary.
    const sameWork =
      failing.length > 0 &&
      failing.every(
        (a) =>
          a.error_kind === 'assertion' && passedDiffs.has(diffs.get(`${a.run_id}\0${a.key}`) ?? ''),
      )
    const cause =
      infra > 0 || failing.some((a) => a.error_kind === 'infra')
        ? 'infra'
        : failing.some((a) => nearThreshold.has(`${a.run_id}\0${a.key}`))
          ? 'judge'
          : sameWork
            ? 'check'
            : 'agent'
    const starts = list.map((c) => c.started_at).sort()
    flakyRows.push({
      eval_key: first.eval_key,
      cell_key: first.key,
      fingerprint: first.comparable,
      runs: list.length,
      flaky_runs: list.filter((c) => c.pass > 0 && c.fail > 0).length,
      first_seen: starts[0] ?? null,
      last_seen: starts.at(-1) ?? null,
      pass,
      counted: pass + fail,
      infra_error: infra,
      pass_at_1: round3(pass / (pass + fail)),
      lo: round3(w.low),
      hi: round3(w.high),
      verdict: pass + fail >= FLAKY_MIN_ATTEMPTS ? 'flaky' : 'insufficient',
      cause,
      min_attempts: FLAKY_MIN_ATTEMPTS,
    })
  }
  flakyRows.sort((a, b) => String(a.first_seen).localeCompare(String(b.first_seen)))
  insertAll(db, 'flaky_m', flakyRows)

  insertAll(db, 'check_streaks_m', checkStreaks(db))
}

type StreakCheck = {
  run_id: string
  eval_key: string
  cell_key: string
  label: string
  comparable: string
  branch: string | null
  role: string
  pass: number
  fail: number
  error: number
  verdict: string | null
}

/**
 * check_streaks: each check per cell, comparable fingerprint and branch, over recorded runs only:
 * how many of its newest runs in a row it passed without a fail or an error (on a variant, only
 * runs where its control passed it too, `both-pass`), the tries those runs counted, and the run
 * that ended it. A run that never reached the check neither extends nor ends the streak.
 */
function checkStreaks(db: DatabaseSync): Row[] {
  const checks = rowsOf<StreakCheck>(
    db.prepare(
      `SELECT k.run_id, k.eval_key, k.cell_key, k.label, c.comparable, r.branch, c.role, k.pass,
        k.fail, k.error, k.verdict
       FROM cell_checks k JOIN runs r USING (run_id)
       JOIN cells c ON c.run_id = k.run_id AND c.eval_key = k.eval_key AND c.key = k.cell_key
       WHERE r.recorded = 1 ORDER BY k.run_id`,
    ),
  )
  const series = new Map<string, StreakCheck[]>()
  for (const k of checks) {
    const id = [k.eval_key, k.cell_key, k.label, k.comparable, k.branch ?? ''].join('\0')
    series.set(id, [...(series.get(id) ?? []), k])
  }
  const rows: Row[] = []
  for (const list of series.values()) {
    const first = list[0] as StreakCheck
    let streakRuns = 0
    let streakTries = 0
    let since: string | null = null
    let endedBy: string | null = null
    for (const k of [...list].reverse()) {
      if (k.pass + k.fail + k.error === 0) continue
      const clean =
        k.fail === 0 && k.error === 0 && (k.role !== 'variant' || k.verdict === 'both-pass')
      if (!clean) {
        endedBy = k.run_id
        break
      }
      streakRuns++
      streakTries += k.pass
      since = k.run_id
    }
    rows.push({
      eval_key: first.eval_key,
      cell_key: first.cell_key,
      label: first.label,
      fingerprint: first.comparable,
      branch: first.branch,
      runs: list.length,
      fails: list.reduce((n, k) => n + k.fail, 0),
      streak_runs: streakRuns,
      streak_tries: streakTries,
      streak_since: since,
      last_run: list.at(-1)?.run_id ?? null,
      ended_by: endedBy,
    })
  }
  return rows
}
