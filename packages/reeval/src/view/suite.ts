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
import { EFFECT_MIN_COUNTED, liftInterval, round3 } from '../stats.ts'
import type { ErrorKind, Outcome } from '../types.ts'
import { cellEffort, cellSamples, contrastEffort, type EffortVerdict } from './effort.ts'
import { caseLabel } from './family.ts'
import { checksByLabel, checkTries, labelledJudgements } from './judgements.ts'
import { isNotGatedPass, runOutcome } from './model.ts'

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

export { EFFECT_MIN_COUNTED }

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
  /**
   * The run's outcome, which `reeval run`'s exit code is read from: `fail` on any error outside
   * an attempt, and `skipped` on an interrupted run.
   */
  outcome: Outcome
  /**
   * Errors outside any attempt: an eval file that didn't load, a rejection or throw no attempt
   * awaited, a worker that died. Any one fails the run.
   */
  errors: string[]
  /**
   * Outcomes counted per block: each family case is one, each eval with no cases is one, and a
   * family whose pooled gate failed is one more fail. `errors` counts the run's `errors`, and
   * `notGated` the passes whose cells are all `gate: 'none'` (studies), which `pass` leaves out.
   */
  tally: SuiteTally
  /** Sorted by path. */
  files: ResultFile[]
  /** Every node's `path`, in the order they appear. */
  paths: string[]
}

export type SuiteTally = {
  errors: number
  pass: number
  notGated: number
  fail: number
  infraError: number
  cancelled: number
  skipped: number
}

/**
 * An eval's or a family case's outcome: the record's, except `cancelled` where its only failed
 * gated attempts are ones the run's interrupt cancelled, since the agent didn't fail those.
 */
export type ResultOutcome = Outcome | 'cancelled'

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
  outcome: ResultOutcome
  cells: CellResult[] | null
  cases: CaseResult[] | null
  /** A family's variants against their baseline, pooled over the cases; null on a single eval. */
  pooled: PooledArm[] | null
  /**
   * Its compare questions' answers. On a family, each question asked of any case, in first-asked
   * order, with its votes and wins summed over the cases that answered it.
   */
  questions: QuestionResult[]
}

/** A compare question: each side's wins over the pairs the model decided. Never gates. */
export type QuestionResult = {
  question: string
  /** Pairs voted, each counted once per order it was asked in. */
  votes: number
  rates: Array<{ cut: 'within' | 'across'; name: string; wins: number; n: number }>
  /** Why some or all of its votes are missing: the model call failed. */
  error: string | null
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
  outcome: ResultOutcome
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
  /**
   * Every check the eval's attempts recorded (on a family, any case's). A cell with no counted
   * attempt (every one an infra error or skipped) lists each as `not run`.
   */
  checks: CheckResult[]
  /** On a variant, against its baseline; null on a control. */
  effect: Effect | null
  /** The stored 95% interval on the variant's difference from its baseline. Not for display. */
  interval: Interval | null
  /** On a variant, the compare's `minLift`, a fraction like the interval; null without one. */
  minLift: number | null
  /** Medians over the counted attempts; null below `EFFECT_MIN_COUNTED` of them. */
  effort: EffortCounters | null
  /** On a variant, its tool calls, agent time or tokens differ from its baseline's by the rank test. */
  effortDiffers: boolean
  /** Why attempts failed or errored where no check says: a timeout, an infra error, a throw. */
  errors: CellError[]
  /** Web searches and fetches per counted attempt; null where the harness can't report them. */
  searches: Array<number | null>
  fetches: Array<number | null>
}

/** A cell's attempts the run's interrupt cancelled: recorded as fails, but not the agent's. */
export const cancelledOf = (cell: CellResult) =>
  cell.errors.filter((err) => err.kind === 'aborted').reduce((n, err) => n + err.attempts, 0)

/** A cell's counted tries: its passes and fails, less the ones the interrupt cancelled. */
export const countedOf = (cell: CellResult) =>
  Math.max(0, cell.passed + cell.failed - cancelledOf(cell))

export type CheckResult = {
  path: string
  label: string
  /** First-seen order across the eval's attempts. */
  order: number
  outcome: CheckOutcome
  /**
   * On a variant, this check against the baseline's (`unclear` when the baseline never ran it);
   * null on a control or without one.
   */
  effect: Effect | null
  /** Set when the check is a judge verdict. */
  judge: JudgeResult | null
  /**
   * A `toSucceed` check whose `c.exec` had `retries` and needed them: on one counted attempt how
   * it ended (`passed on try 2 of 3`, `failed all 3 tries`), on several how many retried. Unset
   * when none did.
   */
  retried?: string
}

/**
 * `not run`: no counted attempt reached the check, because a hard `expect` before it failed or
 * none counted. That is not a failure, and is never `0 of N`. `ran`: counts over the counted attempts that
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

/**
 * One distinct error over a cell's attempts: its kind (`turn` for a turn the harness ended with
 * an error), its message's first line, and how often.
 */
export type CellError = {
  kind: ErrorKind | 'turn'
  message: string
  attempts: number
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
  /** The compare's `minLift`, a fraction like the interval, which gates its low end; null without one. */
  minLift: number | null
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

/** Every check label the attempts recorded, in first-seen order: the eval's declared checks. */
function declaredChecks(entries: readonly EvalEntry[]): string[] {
  return [
    ...new Set(
      entries.flatMap((e) => e.attempts.flatMap((a) => (a.assertions ?? []).map((x) => x.label))),
    ),
  ]
}

function checksOf(
  e: EvalEntry,
  cell: CellRecord,
  baseline: CellRecord | undefined,
  base: string,
  declared: readonly string[],
): CheckResult[] {
  const attempts = e.attempts.filter((a) => a.cell === cell.key && counted(a))
  // The record tallies checks over counted attempts only, so a cell with none has no tallies.
  const tallies =
    cell.checks ?? declared.map((label) => ({ label, pass: 0, fail: 0, error: 0, notRun: 0 }))
  return tallies.map((k, order) => {
    const ran = k.pass + k.fail + k.error
    const answered = attempts
      .flatMap((a) => a.assertions ?? [])
      .filter((x) => x.label === k.label && x.message)
    const assertion =
      (answered.find((x) => x.status === 'fail') ?? answered.find((x) => x.status === 'error'))
        ?.message ?? null
    // A baseline with no counted attempt records no checks: it never ran this one.
    const control = baseline
      ? (baseline.checks?.find((x) => x.label === k.label) ?? {
          pass: 0,
          fail: 0,
          error: 0,
          notRun: 0,
        })
      : undefined
    const judged = attempts.flatMap((a) =>
      labelledJudgements(a)
        .filter((j) => j.check === k.label)
        .map((j) => j.judgement),
    )
    const first = judged[0]
    const notes = attempts.flatMap((a) => {
      const check = checksByLabel(a).get(k.label)
      const note = check && checkTries(check)
      return note ? [note] : []
    })
    const retried =
      attempts.length === 1
        ? notes[0]
        : notes.length
          ? `retried in ${notes.length} of ${attempts.length} attempts`
          : undefined
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
      ...(retried ? { retried } : {}),
    }
  })
}

const informative = (line: string) => /[\p{L}\p{N}]/u.test(line)

/**
 * An error's one line: its first line with any letter or digit in it, joined with the next one
 * when it ends with `:`, since `Docker failed:` alone says nothing. A log line's `| ` is dropped.
 */
export function messageLine(text: string): string {
  const [first = '', next] = text
    .split('\n')
    .map((l) => l.trim())
    .filter(informative)
  return first.endsWith(':') && next ? `${first} ${next.replace(/^[|>]\s*/, '')}` : first
}

/**
 * The errors of a cell's failed and infra-error attempts that no failed check explains: every
 * timeout, infra error and abort, and an assertion or judge error on an attempt whose recorded
 * checks all passed (a throw in the eval's body), plus each turn's error, which is often why.
 */
function errorsOf(e: EvalEntry, cell: CellRecord): CellError[] {
  const out: CellError[] = []
  const add = (kind: CellError['kind'], text: string) => {
    const message = messageLine(text)
    const same = out.find((x) => x.kind === kind && x.message === message)
    if (same) same.attempts++
    else out.push({ kind, message, attempts: 1 })
  }
  for (const a of e.attempts) {
    if (a.cell !== cell.key) continue
    if (a.outcome !== 'fail' && a.outcome !== 'infra_error') continue
    for (const turn of a.turns ?? []) if (turn.error) add('turn', turn.error)
    if (!a.error) continue
    const checked = a.error.kind === 'assertion' || a.error.kind === 'judge'
    if (checked && (a.assertions ?? []).some((x) => x.status !== 'pass')) continue
    add(a.error.kind, a.error.message)
  }
  return out
}

function effortDiffers(e: EvalEntry, cell: CellRecord, baseline: CellRecord | undefined): boolean {
  if (!baseline) return false
  const c = contrastEffort(cellSamples(e, cell.key), cellSamples(e, baseline.key))
  if (!c) return false
  const moved = (v: EffortVerdict | null) => v === 'fewer' || v === 'more'
  return moved(c.verdict) || moved(c.timeVerdict) || moved(c.tokensVerdict)
}

function questionsOf(e: EvalEntry): QuestionResult[] {
  return (e.answers ?? []).map((a) => ({
    question: a.question,
    votes: a.votes.length,
    rates: a.rates.map((r) => ({ cut: r.cut, name: r.name, wins: r.wins, n: r.n })),
    error: a.error ?? null,
  }))
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

function cellsOf(
  record: RunRecord,
  e: EvalEntry,
  parent: string,
  declared: readonly string[],
): CellResult[] {
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
      checks: checksOf(e, cell, baseline, path, declared),
      effect: cell.role === 'variant' ? cellEffect(cell, baseline, interval) : null,
      interval,
      minLift: lift?.minLift ?? null,
      effort: effortOf(e, cell),
      effortDiffers: cell.role === 'variant' && effortDiffers(e, cell, baseline),
      errors: errorsOf(e, cell),
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

/** Fail beats infra error, which beats cancelled, which beats pass; skipped only when every one was. */
function worst(outcomes: ResultOutcome[]): ResultOutcome {
  if (outcomes.includes('fail')) return 'fail'
  if (outcomes.includes('infra_error')) return 'infra_error'
  if (outcomes.includes('cancelled')) return 'cancelled'
  if (outcomes.length && outcomes.every((o) => o === 'skipped')) return 'skipped'
  return 'pass'
}

/** A study: every cell `gate: 'none'`, so it passes whatever it saw and never reads `pass`. */
export const isStudy = (cells: readonly Pick<CellResult, 'gated'>[]): boolean =>
  cells.length > 0 && cells.every((c) => !c.gated)

/**
 * A study's pass: every cell `gate: 'none'`, or on a family every case's with no pooled `minLift`
 * gating it, so it reads `not gated`, never `pass`.
 */
export const isNotGatedResult = (
  e: Pick<EvalResult, 'outcome' | 'cells' | 'cases' | 'pooled'>,
): boolean =>
  e.outcome === 'pass' &&
  (e.cases
    ? e.cases.length > 0 &&
      e.cases.every((k) => isStudy(k.cells)) &&
      (e.pooled ?? []).every((p) => p.minLift === null)
    : isStudy(e.cells ?? []))

/** The record's outcome, or `cancelled` when every gated attempt that failed was cancelled. */
function outcomeOf(e: EvalEntry): ResultOutcome {
  if (e.outcome !== 'fail') return e.outcome
  const gated = new Set(e.cells.filter((c) => c.gate !== 'none').map((c) => c.key))
  const failed = e.attempts.filter((a) => a.outcome === 'fail' && gated.has(a.cell))
  return failed.length && failed.every((a) => a.error?.kind === 'aborted') ? 'cancelled' : 'fail'
}

/** Each question any case asked, in first-asked order, with votes and wins summed over the cases. */
function familyQuestions(cases: readonly EvalEntry[]): QuestionResult[] {
  const out = new Map<string, QuestionResult>()
  for (const q of cases.flatMap(questionsOf)) {
    const have = out.get(q.question)
    if (!have) {
      out.set(q.question, { ...q, rates: q.rates.map((r) => ({ ...r })) })
      continue
    }
    have.votes += q.votes
    have.error ??= q.error
    for (const r of q.rates) {
      const same = have.rates.find((x) => x.cut === r.cut && x.name === r.name)
      if (!same) have.rates.push({ ...r })
      else {
        same.wins += r.wins
        same.n += r.n
      }
    }
  }
  return [...out.values()]
}

function familyResult(
  record: RunRecord,
  family: FamilyRecord,
  cases: EvalEntry[],
  order: number,
): EvalResult {
  const path = factSegment(family.id)
  const sorted = [...cases].sort((a, b) => (a.family?.case ?? 0) - (b.family?.case ?? 0))
  const declared = declaredChecks(sorted)
  const cellOf = (key: string) => sorted.flatMap((c) => c.cells).find((c) => c.key === key)
  const results = sorted.map((c): CaseResult => {
    const label = caseLabel(family.name, c.name)
    const casePath = `${path}/${factSegment(label)}`
    return {
      path: casePath,
      id: c.id,
      label,
      name: c.name,
      order: c.family?.case ?? 0,
      outcome: outcomeOf(c),
      cells: cellsOf(record, c, casePath, declared),
    }
  })
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
      ...results.map((c) => c.outcome),
    ]),
    cells: null,
    cases: results,
    pooled: family.lifts.map((lift) => {
      const cell = cellOf(lift.variant)
      return {
        path: `${path}/${cell ? cellSegment(cell) : factSegment(lift.variant)}`,
        key: lift.variant,
        vs: lift.vs,
        effect: pooledEffect(lift),
        pairs: lift.pairs,
        interval: { low: lift.interval.lo, high: lift.interval.hi },
        minLift: lift.minLift ?? null,
        outcome: lift.outcome,
      }
    }),
    questions: familyQuestions(sorted),
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
    outcome: outcomeOf(e),
    cells: cellsOf(record, e, path, declaredChecks([e])),
    cases: null,
    pooled: null,
    questions: questionsOf(e),
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
  const errors = record.errors ?? []
  const tally: SuiteTally = {
    errors: errors.length,
    pass: 0,
    notGated: 0,
    fail: 0,
    infraError: 0,
    cancelled: 0,
    skipped: 0,
  }
  const count = (e: EvalEntry) => {
    const o = outcomeOf(e)
    if (o === 'infra_error') tally.infraError++
    else if (o === 'pass' && isNotGatedPass(e)) tally.notGated++
    else tally[o]++
  }
  for (const e of record.evals) {
    const evals = byFile.get(e.file) ?? []
    byFile.set(e.file, evals)
    count(e)
    const family = e.family && families.get(e.family.id)
    if (!family) {
      evals.push(evalResult(record, e, evals.length))
      continue
    }
    if (seen.has(family.id)) continue
    seen.add(family.id)
    if (family.outcome === 'fail' && family.lifts.some((l) => l.outcome === 'fail')) tally.fail++
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
    errors,
    tally,
    files,
    paths: pathsOf(files),
  }
}
