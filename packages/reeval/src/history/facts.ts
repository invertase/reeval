// The derived facts behind `reeval query effort`, `factor_effects`, `flaky_cells` and `drift`: computed
// in TypeScript after each sync (SQLite has no rank test or Newcombe interval) and materialised in
// `*_m` tables that those views select from. Every verdict here is a fixed rule over the lift
// interval, `within_noise` and an exact rank test, so the analysis step is told, not asked.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { isRuntimeState } from '../attempt/context.ts'
import { liftInterval, round3, wilson } from '../stats.ts'
import {
  contrastEffort,
  type EffortContrast,
  type EffortSample,
  type EffortVerdict,
  effortOf,
} from '../view/effort.ts'

/** Counted attempts, pooled over comparable runs, before a cell with mixed outcomes is `flaky`. */
export const FLAKY_MIN_ATTEMPTS = 6
/**
 * Counted attempts a side before pass-rate lift can exclude 0. Below this the verdict is
 * `insufficient` (not measured). See the table in `docs/concepts/lift.mdx`.
 */
export const LIFT_MIN_COUNTED = 2
/** A failing verdict this close to its threshold points at the judge, not the agent. */
export const JUDGE_MARGIN = 0.1

export const DERIVED_TABLES = `
CREATE TABLE effort_m (
  run_id TEXT, eval_key TEXT, cell_key TEXT, role TEXT, variant TEXT, harness TEXT,
  environment TEXT, n INTEGER, tools_median REAL, tools_q1 REAL, tools_q3 REAL,
  agent_s_median REAL, agent_s_q1 REAL, agent_s_q3 REAL, file_edits_median REAL,
  control_key TEXT, control_n INTEGER, control_tools_median REAL, control_agent_s_median REAL,
  tools_ratio REAL, agent_s_ratio REAL, agent_s_delta REAL, tools_p REAL, agent_s_p REAL,
  separated INTEGER, verdict TEXT, time_verdict TEXT
);
CREATE TABLE factor_effects_m (
  factor TEXT, level TEXT, baseline TEXT, context TEXT, tier TEXT, run_id TEXT, eval_key TEXT,
  strata INTEGER, runs INTEGER, variant_pass INTEGER, variant_counted INTEGER,
  control_pass INTEGER, control_counted INTEGER, points REAL, lo REAL, hi REAL,
  within_noise INTEGER, pass_verdict TEXT, tools_ratio REAL, tools_ratios TEXT,
  agent_s_ratio REAL, tools_p REAL, consistent INTEGER, separated INTEGER, effort_verdict TEXT,
  note TEXT
);
CREATE TABLE flaky_m (
  eval_key TEXT, cell_key TEXT, fingerprint TEXT, runs INTEGER, flaky_runs INTEGER,
  first_seen TEXT, last_seen TEXT, pass INTEGER, counted INTEGER, infra_error INTEGER,
  rate REAL, lo REAL, hi REAL, verdict TEXT, cause TEXT, min_attempts INTEGER
);
CREATE TABLE drift_m (
  run_id TEXT, prev_run_id TEXT, eval_key TEXT, cell_key TEXT, changed TEXT,
  changed_paths TEXT, noise INTEGER, real_changed TEXT
);
`

export const DERIVED = ['effort_m', 'factor_effects_m', 'flaky_m', 'drift_m']

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
}

const PARTS = [
  ['sources', 'fp_sources'],
  ['harness', 'fp_harness'],
  ['environment', 'fp_environment'],
  ['image', 'fp_image'],
  ['agent_cli', 'fp_agent_cli'],
  ['judge', 'fp_judge'],
  ['context', 'fp_context'],
] as const

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
  const noise = lift.low <= 0 && lift.high >= 0
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
      Math.min(v.counted, c.counted) < LIFT_MIN_COUNTED
        ? 'insufficient'
        : noise
          ? 'noise'
          : 'effect',
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
  }
}

const merge = (sides: Side[]): Side => ({
  pass: sides.reduce((n, s) => n + s.pass, 0),
  counted: sides.reduce((n, s) => n + s.counted, 0),
  samples: sides.flatMap((s) => s.samples),
})

function insertAll(db: DatabaseSync, table: string, rows: Row[]): void {
  if (rows.length === 0) return
  const cols = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
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
  const cells = db
    .prepare(
      'SELECT c.*, r.started_at FROM cells c JOIN runs r USING (run_id) ORDER BY c.run_id, c.rowid',
    )
    .all() as Cell[]
  const attempts = db
    .prepare(
      'SELECT run_id, eval_key, cell_key, key, outcome, error_kind, tools, agent_ms, file_edits FROM attempts ORDER BY run_id, rowid',
    )
    .all() as Attempt[]
  const nearThreshold = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT run_id, attempt_key FROM judgements WHERE verdict = 'fail' AND ABS(score - threshold) <= ${JUDGE_MARGIN}`,
        )
        .all() as Array<{ run_id: string; attempt_key: string }>
    ).map((r) => `${r.run_id}\0${r.attempt_key}`),
  )
  const samples = new Map<string, EffortSample[]>()
  const byCell = new Map<string, Attempt[]>()
  for (const a of attempts) {
    const id = cellId(a.run_id, a.eval_key, a.cell_key)
    byCell.set(id, [...(byCell.get(id) ?? []), a])
    if (a.outcome !== 'pass' && a.outcome !== 'fail') continue
    samples.set(id, [
      ...(samples.get(id) ?? []),
      { tools: a.tools, agentMs: a.agent_ms, fileEdits: a.file_edits },
    ])
  }
  const side = (c: Cell): Side => ({
    pass: c.pass,
    counted: c.pass + c.fail,
    samples: samples.get(cellId(c.run_id, c.eval_key, c.key)) ?? [],
  })
  const find = (run: string, evalKey: string, key: string) =>
    cells.find((c) => c.run_id === run && c.eval_key === evalKey && c.key === key)

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
      control_key: control?.key ?? null,
      control_n: vs?.control.n ?? null,
      control_tools_median: vs?.control.tools.median ?? null,
      control_agent_s_median: vs ? s1(vs.control.agentMs.median) : null,
      tools_ratio: r4(vs?.toolsRatio ?? null),
      agent_s_ratio: r4(vs?.agentMsRatio ?? null),
      agent_s_delta: vs ? s1(vs.agentMsDelta) : null,
      tools_p: r4(vs?.toolsP ?? null),
      agent_s_p: r4(vs?.agentMsP ?? null),
      separated: vs ? (vs.separated ? 1 : 0) : null,
      verdict: vs?.verdict ?? null,
      time_verdict: vs?.timeVerdict ?? null,
    }
  })
  insertAll(db, 'effort_m', effortRows)

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
  // evals with each (eval, comparable runs) group as a stratum.
  const pooled = new Map<string, Pair[]>()
  for (const p of pairs) {
    const id = [p.factor, p.level, p.baseline, p.context, p.evalKey, p.pool].join('\0')
    pooled.set(id, [...(pooled.get(id) ?? []), p])
  }
  const strata = new Map<string, Array<{ v: Side; c: Side }>>()
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
    strata.set(id, [...(strata.get(id) ?? []), { v, c }])
  }
  for (const [id, list] of strata) {
    if (list.length < 2) continue
    const [factor, level, baseline, context] = id.split('\0') as [string, string, string, string]
    const v = merge(list.map((s) => s.v))
    const c = merge(list.map((s) => s.c))
    factorRows.push({
      ...head({ factor, level, baseline, context }),
      tier: 'pooled',
      run_id: null,
      eval_key: null,
      strata: list.length,
      runs: null,
      ...passCols(v, c),
      ...pooledEffort(list.map((s) => contrastEffort(s.v.samples, s.c.samples))),
      note: 'pass rate: summed counts; effort: an effect in at least 2/3 of strata',
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
      for (const f of contextOf.all(c.run_id, a.key) as Array<{ path: string; sha256: string }>) {
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
        ...passCols(side(cur), side(prev)),
        ...effortCols(contrastEffort(side(cur).samples, side(prev).samples)),
        note: judgeOnly
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
    const cause =
      infra > 0 || failing.some((a) => a.error_kind === 'infra')
        ? 'infra'
        : failing.some((a) => nearThreshold.has(`${a.run_id}\0${a.key}`))
          ? 'judge'
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
      rate: round3(pass / (pass + fail)),
      lo: round3(w.low),
      hi: round3(w.high),
      verdict: pass + fail >= FLAKY_MIN_ATTEMPTS ? 'flaky' : 'insufficient',
      cause,
      min_attempts: FLAKY_MIN_ATTEMPTS,
    })
  }
  flakyRows.sort((a, b) => String(a.first_seen).localeCompare(String(b.first_seen)))
  insertAll(db, 'flaky_m', flakyRows)
}

/** An effort verdict as a short phrase, for tables and the digest. */
export const effortPhrase = (verdict: EffortVerdict | null, p: number | null) =>
  verdict === 'fewer' || verdict === 'more'
    ? `${verdict} tool calls (p = ${p?.toFixed(3)})`
    : verdict === 'insufficient'
      ? 'too few attempts to test'
      : verdict === 'noise'
        ? 'within noise'
        : '–'
