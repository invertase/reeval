// The facts of one run as the output layouts read them: files, evals (or a family's cases),
// cells and checks, with each variant's effect. Recomputed from the record on every read and
// never persisted, so a run recorded by any reeval renders. No model is involved: every field
// here is the result, and the exit code reads only these.
import type {
  AttemptRecord,
  CellRecord,
  CheckTally,
  EvalEntry,
  FamilyLift,
  FamilyRecord,
  RunRecord,
} from '../history/types.ts'
import { liftInterval, round3 } from '../stats.ts'
import type { Outcome } from '../types.ts'
import { cellEffort } from './effort.ts'
import { caseLabel } from './family.ts'
import { labelledJudgements } from './judgements.ts'
import { runOutcome } from './model.ts'

/**
 * A variant against its baseline: `better` or `worse` when the stored 95% interval on the
 * difference excludes 0, `same` when both pass at the same rate, and `unclear` otherwise,
 * including whenever either side has fewer than `EFFECT_MIN_COUNTED` counted attempts.
 */
export type Effect = 'better' | 'worse' | 'same' | 'unclear'

/**
 * What an eval's cells compare: `change` when it has variants (or several environments),
 * `harness` when it has several harnesses, `both`, or `none`.
 */
export type Across = 'none' | 'change' | 'harness' | 'both'

/** The fewest counted attempts a side for an effect to be anything but `unclear`. */
export const EFFECT_MIN_COUNTED = 4

/**
 * One finished run's facts. Every node has a `path`, a stable id to cite it by, and `paths`
 * lists them all in the order the nodes appear.
 *
 * A path is `/`-separated segments, each with `%`, `/` and `+` percent-encoded:
 *
 * - `<eval>`: the eval's id (`evals/a.eval.ts › group › name`) or a family's
 *   (`evals/a.eval.ts › fixes $id`);
 * - `<eval>/<case>`: a family case, by its label (`GH-101` for `fixes GH-101`);
 * - `<eval>[/<case>]/<harness>+<environment>+<sandbox>`: a cell;
 * - `<cell>/checks/<label>`: a check, by its assertion label;
 * - `<cell>/effort`: the cell's effort, only when it was tested;
 * - `<eval>/<harness>+<environment>+<sandbox>`: on a family, a variant's pooled effect.
 *
 * A case segment never has a raw `+` and a cell segment always has two, so the two can't be
 * confused. Ids, labels and cell keys are what runs are matched on, so a path names the same
 * fact in every run that has it.
 */
export type SuiteResult = {
  runId: string
  status: RunRecord['status']
  /** The run's outcome, as `reeval run`'s exit code has it. */
  outcome: Outcome
  /** Outcomes counted per block: each family case is one, and each eval with no cases is one. */
  tally: { pass: number; fail: number; infraError: number; skipped: number }
  /** Sorted by path. */
  files: ResultFile[]
  /** Every node's `path`, in the order they appear. */
  paths: string[]
}

export type ResultFile = {
  path: string
  evals: EvalResult[]
}

export type EvalResult = {
  path: string
  /** The eval's id, or the family's. */
  id: string
  group: string[]
  /** The eval's name; on a family, its template. */
  name: string
  /** A family's name template (`fixes $id`); null on a single eval. */
  template: string | null
  /** Source order in the file. */
  order: number
  across: Across
  /**
   * A pooled `evaluate.each` with two or more cases: `cases` is set and `cells` is null. An
   * unpooled one (`{ pool: false }`) is recorded as separate evals, each a single eval.
   */
  family: boolean
  /** A placeholder (`evaluate.todo`) that never ran. */
  todo: boolean
  /** On a family: `fail` when a case failed or its pooled gate did. */
  outcome: Outcome
  cells: CellResult[] | null
  cases: CaseResult[] | null
  /** A family's variants against their baseline, pooled over the cases; null on a single eval. */
  pooled: PooledArm[] | null
}

export type CaseResult = {
  path: string
  /** The case's own eval id. */
  id: string
  /** Its name less the template's literal text: `GH-101` for `fixes GH-101`. */
  label: string
  name: string
  /** Its place in the case list. */
  order: number
  outcome: Outcome
  cells: CellResult[]
}

export type CellResult = {
  path: string
  key: string
  harness: string
  /** `-` when no environment is set. */
  environment: string
  sandbox: string
  /** The variant's name; null on a control. */
  variant: string | null
  /** The control of an eval that has variants: the arm the variants are measured against. */
  baseline: boolean
  /** On a variant, its baseline cell's key; else null. */
  vs: string | null
  /** The cell's place in the eval's cells. */
  order: number
  /** Its failures fail the eval (its gate isn't `'none'`). */
  gated: boolean
  outcome: Outcome
  /** Every attempt: `passed + failed + infraError + skipped`. */
  attempts: number
  passed: number
  failed: number
  /** Infrastructure errors, which are neither passes nor fails. */
  infraError: number
  skipped: number
  fingerprint: string
  /** The skill sources and files the cell's environment placed, as written. */
  context: string[]
  checks: CheckResult[]
  /** On a variant, against its baseline; null on a control. */
  effect: Effect | null
  /** The stored 95% interval on the variant's difference from its baseline. Not for display. */
  interval: Interval | null
  /** Medians over the counted attempts; null below `EFFECT_MIN_COUNTED` of them. */
  effort: EffortCounters | null
  /** Web searches and fetches per counted attempt; null where the harness can't report them. */
  searches: Array<number | null>
  fetches: Array<number | null>
}

export type CheckResult = {
  path: string
  label: string
  /** First-seen order across the eval's attempts. */
  order: number
  outcome: CheckOutcome
  /** On a variant, this check against the baseline's; null on a control or without one. */
  effect: Effect | null
  /** Set when the check is a judge verdict. */
  judge: JudgeResult | null
}

/**
 * `not run`: no counted attempt reached the check, because a hard `expect` before it failed.
 * That is not a failure, and is never `0 of N`. `ran`: counts over the counted attempts that
 * reached it (`errored` ones couldn't answer), with `notRun` for those that didn't, and the
 * first failure's message.
 */
export type CheckOutcome =
  | { status: 'not run' }
  | {
      status: 'ran'
      passed: number
      failed: number
      errored: number
      notRun: number
      assertion: string | null
    }

export type JudgeResult = {
  question: string
  threshold: number
  /** One per counted attempt that judged it. */
  scores: number[]
}

export type Interval = { low: number; high: number }

/** A null counter is one the harness didn't record; a recorded zero stays zero. */
export type EffortCounters = {
  tools: number | null
  agentMs: number | null
  tokens: number | null
}

export type PooledArm = {
  path: string
  /** The variant cell's key, the same in every case. */
  key: string
  vs: string
  effect: Effect
  /** Cases with counted attempts on both sides. */
  pairs: number
  interval: Interval
  outcome: 'pass' | 'fail'
}

type Side = { pass: number; counted: number }

/**
 * The effect of `variant` against `control`, from the interval on their difference. A side
 * with fewer than `EFFECT_MIN_COUNTED` counted attempts is `unclear`, whatever the interval.
 */
export function effectOf(variant: Side, control: Side, interval: Interval | null): Effect {
  if (variant.counted < EFFECT_MIN_COUNTED || control.counted < EFFECT_MIN_COUNTED) {
    return 'unclear'
  }
  if (variant.pass * control.counted === control.pass * variant.counted) return 'same'
  if (!interval) return 'unclear'
  if (interval.low > 0) return 'better'
  if (interval.high < 0) return 'worse'
  return 'unclear'
}

/** A check's passes over the attempts that answered it; `notRun` and `error` aren't counted. */
const checkSide = (t: CheckTally): Side => ({ pass: t.pass, counted: t.pass + t.fail })

/** The check's effect, on the same Newcombe interval the record stores for a cell's lift. */
export function checkEffect(variant: CheckTally, control: CheckTally): Effect {
  const v = checkSide(variant)
  const c = checkSide(control)
  if (v.counted === 0 || c.counted === 0) return 'unclear'
  const { low, high } = liftInterval({ pass: v.pass, n: v.counted }, { pass: c.pass, n: c.counted })
  return effectOf(v, c, { low: round3(low), high: round3(high) })
}

/** One path segment: `%`, `/` and `+` percent-encoded, so segments split back unambiguously. */
export const factSegment = (s: string) =>
  s.replace(/%/g, '%25').replace(/\//g, '%2F').replace(/\+/g, '%2B')

const cellSegment = (c: Pick<CellRecord, 'harness' | 'environment' | 'sandbox'>) =>
  [c.harness, c.environment, c.sandbox].map(factSegment).join('+')

const counted = (a: Pick<AttemptRecord, 'outcome'>) => a.outcome === 'pass' || a.outcome === 'fail'

export function evalAcross(
  cells: readonly Pick<CellRecord, 'harness' | 'environment' | 'role'>[],
): Across {
  const harness = new Set(cells.map((c) => c.harness)).size > 1
  const change =
    cells.some((c) => c.role === 'variant') || new Set(cells.map((c) => c.environment)).size > 1
  return harness && change ? 'both' : harness ? 'harness' : change ? 'change' : 'none'
}

/** The skill sources and files an environment placed; `local:` sources as their path. */
function contextOf(record: RunRecord, cell: CellRecord): string[] {
  const envs = record.environments.filter((e) => e.digest === cell.environmentDigest)
  const env = envs.find((e) => e.name === cell.environment) ?? envs[0]
  if (!env) return []
  return [
    ...env.skills.map((s) => s.source.replace(/^local:/, '')),
    ...env.files.map((f) => f.path),
  ]
}

/** The control a variant is measured against: its lift's, else the control on its harness and sandbox. */
function baselineOf(e: EvalEntry, cell: CellRecord): CellRecord | undefined {
  if (cell.role !== 'variant') return undefined
  const vs = cell.lift?.vs
  return vs
    ? e.cells.find((c) => c.key === vs)
    : e.cells.find(
        (c) => c.role === 'control' && c.harness === cell.harness && c.sandbox === cell.sandbox,
      )
}

function checksOf(
  e: EvalEntry,
  cell: CellRecord,
  baseline: CellRecord | undefined,
  base: string,
): CheckResult[] {
  const attempts = e.attempts.filter((a) => a.cell === cell.key && counted(a))
  return (cell.checks ?? []).map((k, order) => {
    const ran = k.pass + k.fail + k.error
    const assertion =
      attempts
        .flatMap((a) => a.assertions ?? [])
        .find((x) => x.label === k.label && x.status !== 'pass' && x.message)?.message ?? null
    const control = baseline?.checks?.find((x) => x.label === k.label)
    const judged = attempts.flatMap((a) =>
      labelledJudgements(a)
        .filter((j) => j.check === k.label)
        .map((j) => j.judgement),
    )
    const first = judged[0]
    return {
      path: `${base}/checks/${factSegment(k.label)}`,
      label: k.label,
      order,
      outcome:
        ran === 0
          ? { status: 'not run' }
          : {
              status: 'ran',
              passed: k.pass,
              failed: k.fail,
              errored: k.error,
              notRun: k.notRun,
              assertion,
            },
      effect: control ? checkEffect(k, control) : null,
      judge: first
        ? {
            question: first.question,
            threshold: first.threshold,
            scores: judged.map((j) => j.score),
          }
        : null,
    }
  })
}

function effortOf(e: EvalEntry, cell: CellRecord): EffortCounters | null {
  const effort = cellEffort(e, cell.key)
  if (!effort || effort.n < EFFECT_MIN_COUNTED) return null
  return {
    tools: effort.tools.median,
    agentMs: effort.agentMs.median,
    tokens: effort.tokens?.median ?? null,
  }
}

/** A variant's effect from its stored lift; with none (nothing counted on a side), `unclear`. */
function cellEffect(
  cell: CellRecord,
  baseline: CellRecord | undefined,
  interval: Interval | null,
): Effect {
  if (cell.lift) return effectOf(cell.lift.variant, cell.lift.control, interval)
  if (!baseline) return 'unclear'
  return effectOf(
    { pass: cell.pass, counted: cell.pass + cell.fail },
    { pass: baseline.pass, counted: baseline.pass + baseline.fail },
    null,
  )
}

function cellsOf(record: RunRecord, e: EvalEntry, parent: string): CellResult[] {
  const hasVariants = e.cells.some((c) => c.role === 'variant')
  return e.cells.map((cell, order) => {
    const path = `${parent}/${cellSegment(cell)}`
    const baseline = baselineOf(e, cell)
    const attempts = e.attempts.filter((a) => a.cell === cell.key && counted(a))
    const lift = cell.lift
    const interval = lift ? { low: lift.interval.lo, high: lift.interval.hi } : null
    return {
      path,
      key: cell.key,
      harness: cell.harness,
      environment: cell.environment,
      sandbox: cell.sandbox,
      variant: cell.variant ?? null,
      baseline: hasVariants && cell.role === 'control',
      vs: baseline?.key ?? null,
      order,
      gated: cell.gate !== 'none',
      outcome: cell.outcome,
      attempts: cell.runs,
      passed: cell.pass,
      failed: cell.fail,
      infraError: cell.infraError,
      skipped: cell.skipped,
      fingerprint: cell.fingerprint,
      context: contextOf(record, cell),
      checks: checksOf(e, cell, baseline, path),
      effect: cell.role === 'variant' ? cellEffect(cell, baseline, interval) : null,
      interval,
      effort: effortOf(e, cell),
      searches: attempts.map((a) => a.activity.webSearches),
      fetches: attempts.map((a) => a.activity.webFetches),
    }
  })
}

function pooledEffect(lift: FamilyLift): Effect {
  if (lift.verdict === 'insufficient' || lift.pairs < EFFECT_MIN_COUNTED) return 'unclear'
  if (lift.variantRate === lift.controlRate) return 'same'
  if (lift.interval.lo > 0) return 'better'
  if (lift.interval.hi < 0) return 'worse'
  return 'unclear'
}

/** Fail beats infra error, which beats pass; skipped only when every one was. */
function worst(outcomes: Outcome[]): Outcome {
  if (outcomes.includes('fail')) return 'fail'
  if (outcomes.includes('infra_error')) return 'infra_error'
  if (outcomes.length && outcomes.every((o) => o === 'skipped')) return 'skipped'
  return 'pass'
}

function familyResult(
  record: RunRecord,
  family: FamilyRecord,
  cases: EvalEntry[],
  order: number,
): EvalResult {
  const path = factSegment(family.id)
  const sample = cases[0] as EvalEntry
  const sorted = [...cases].sort((a, b) => (a.family?.case ?? 0) - (b.family?.case ?? 0))
  const cellOf = (key: string) => sample.cells.find((c) => c.key === key)
  return {
    path,
    id: family.id,
    group: family.group,
    name: family.name,
    template: family.name,
    order,
    across: evalAcross(cases.flatMap((c) => c.cells)),
    family: true,
    todo: false,
    outcome: worst([
      ...(family.outcome === 'fail' ? ['fail' as const] : []),
      ...sorted.map((c) => c.outcome),
    ]),
    cells: null,
    cases: sorted.map((c) => {
      const label = caseLabel(family.name, c.name)
      const casePath = `${path}/${factSegment(label)}`
      return {
        path: casePath,
        id: c.id,
        label,
        name: c.name,
        order: c.family?.case ?? 0,
        outcome: c.outcome,
        cells: cellsOf(record, c, casePath),
      }
    }),
    pooled: family.lifts.map((lift) => {
      const cell = cellOf(lift.variant)
      return {
        path: `${path}/${cell ? cellSegment(cell) : factSegment(lift.variant)}`,
        key: lift.variant,
        vs: lift.vs,
        effect: pooledEffect(lift),
        pairs: lift.pairs,
        interval: { low: lift.interval.lo, high: lift.interval.hi },
        outcome: lift.outcome,
      }
    }),
  }
}

function evalResult(record: RunRecord, e: EvalEntry, order: number): EvalResult {
  const path = factSegment(e.id)
  return {
    path,
    id: e.id,
    group: e.group,
    name: e.name,
    template: null,
    order,
    across: evalAcross(e.cells),
    family: false,
    todo: e.todo,
    outcome: e.outcome,
    cells: cellsOf(record, e, path),
    cases: null,
    pooled: null,
  }
}

function pathsOf(files: ResultFile[]): string[] {
  const out: string[] = []
  const cell = (c: CellResult) => {
    out.push(c.path)
    for (const k of c.checks) out.push(k.path)
    if (c.effort) out.push(`${c.path}/effort`)
  }
  for (const file of files) {
    for (const e of file.evals) {
      out.push(e.path)
      for (const c of e.cells ?? []) cell(c)
      for (const k of e.cases ?? []) {
        out.push(k.path)
        for (const c of k.cells) cell(c)
      }
      for (const p of e.pooled ?? []) out.push(p.path)
    }
  }
  return out
}

/** The facts of a run, from its record. Pure: the same record always gives the same result. */
export function suiteResult(record: RunRecord): SuiteResult {
  const families = new Map((record.families ?? []).map((f) => [f.id, f]))
  const byFile = new Map<string, EvalResult[]>()
  const seen = new Set<string>()
  const tally = { pass: 0, fail: 0, infraError: 0, skipped: 0 }
  const count = (o: Outcome) => {
    if (o === 'infra_error') tally.infraError++
    else tally[o]++
  }
  for (const e of record.evals) {
    const evals = byFile.get(e.file) ?? []
    byFile.set(e.file, evals)
    count(e.outcome)
    const family = e.family && families.get(e.family.id)
    if (!family) {
      evals.push(evalResult(record, e, evals.length))
      continue
    }
    if (seen.has(family.id)) continue
    seen.add(family.id)
    const cases = record.evals.filter((x) => x.family?.id === family.id)
    evals.push(familyResult(record, family, cases, evals.length))
  }
  const files = [...byFile]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, evals]) => ({ path, evals }))
  return {
    runId: record.runId,
    status: record.status,
    outcome: runOutcome(record),
    tally,
    files,
    paths: pathsOf(files),
  }
}
