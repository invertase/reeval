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
  UpstreamCount,
} from '../history/types.ts'
import { EFFECT_MIN_COUNTED, liftInterval, round3 } from '../stats.ts'
import type { ErrorKind, Outcome } from '../types.ts'
import { cellEffort, cellSamples, contrastEffort, type EffortVerdict } from './effort.ts'
import { caseLabel } from './family.ts'
import { checksByLabel, checkTries, labeledJudgments } from './judgments.ts'
import { attemptAnswerRows, isNotGatedPass, runOutcome } from './model.ts'
import { type ObservedTally, observedTallies } from './observations.ts'

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
 * One finished run's facts. Every node has a `path`, a stable id that remarks cite it by.
 *
 * A path is `/`-separated segments, each with `%`, `/` and `+` percent-encoded:
 *
 * - `<eval>`: the eval's id (`evals/a.eval.ts › group › name`) or a family's
 *   (`evals/a.eval.ts › fixes $id`);
 * - `<eval>/<case>`: a family case, by its label (`GH-101` for `fixes GH-101`);
 * - `<eval>[/<case>]/<harness>+<environment>+<sandbox>`: a cell;
 * - `<cell>/checks/<label>`: a check, by its assertion label;
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
}

export type SuiteTally = {
  errors: number
  pass: number
  notGated: number
  fail: number
  infraError: number
  canceled: number
  skipped: number
}

/**
 * An eval's or a family case's outcome: the record's, except `canceled` where its only failed
 * gated attempts are ones the run's interrupt canceled, since the agent didn't fail those.
 */
export type ResultOutcome = Outcome | 'canceled'

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
   * A eval with `cases` with two or more cases: `cases` is set and `cells` is null. An
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
   * Its questions' answers: the pairwise ones, then those asked of each attempt. On a family,
   * each question asked of any case, in first-asked order, summed over the cases that answered it.
   */
  questions: Array<QuestionResult | AttemptQuestionResult>
  /** Each name its attempts observed with `c.observe`, tallied per cell; empty on a family. */
  observations: ObservedTally[]
}

/** A pairwise question: each side's wins over the pairs the model decided. Never gates. */
export type QuestionResult = {
  kind: 'pairs'
  question: string
  /** Pairs voted, each counted once per order it was asked in. */
  votes: number
  rates: Array<{ cut: 'within' | 'across'; name: string; wins: number; n: number }>
  /** Why some or all of its votes are missing: the model call failed. */
  error: string | null
}

/** A question asked of each attempt on its own: what each one answered. Never gates. */
export type AttemptQuestionResult = {
  kind: 'attempts'
  question: string
  /** Attempts it was asked of, failed calls included. */
  asked: number
  /** How many attempts picked each choice, in the question's order; null on a free-text question. */
  choices: Array<{ choice: string; n: number }> | null
  /** Each attempt's answer, in attempt order; failed calls left out. */
  answers: Array<{ attempt: string; choice: string | null; text: string }>
  /** Calls that failed, and the first one's error. */
  failed: number
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
  /** Set by `runs: { bestOf }`: the cell stopped once a majority of this many attempts agreed. */
  bestOf?: number
  /** Of `skipped`, the attempts a best-of cell's majority left unrun. */
  notNeeded?: number
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
  /**
   * Where each failed attempt's final snapshot is, from the project's root
   * (`.reeval/runs/<run>/…/snapshots/final`); absent when none has one.
   */
  snapshots?: string[]
  /** Web searches and fetches per counted attempt; null where the harness can't report them. */
  searches: Array<number | null>
  fetches: Array<number | null>
  /**
   * The upstream providers a gateway (OpenRouter) said served the cell's agent calls, with how
   * many, summed over its attempts in first-seen order; absent when it named none.
   */
  upstreams?: UpstreamCount[]
  /** The same for the cell's judge calls; absent when the gateway named none. */
  judgeUpstreams?: UpstreamCount[]
  /**
   * Each `c.capture()` in its attempts whose page had page errors, with the `.capture.json` that
   * lists them (`.reeval/runs/<run>/…/artifacts/<name>.capture.json`); absent when none had any.
   */
  pageErrors?: Array<{ capture: string; errors: number; file: string }>
}

/** Summed per provider, in first-seen order. */
function tallyUpstreams(counts: Iterable<UpstreamCount>): UpstreamCount[] {
  const by = new Map<string, number>()
  for (const { provider, calls } of counts) by.set(provider, (by.get(provider) ?? 0) + calls)
  return [...by].map(([provider, calls]) => ({ provider, calls }))
}

/** A cell's attempts the run's interrupt canceled: recorded as fails, but not the agent's. */
export const canceledOf = (cell: CellResult) =>
  cell.errors.filter((err) => err.kind === 'aborted').reduce((n, err) => n + err.attempts, 0)

/** A cell's counted tries: its passes and fails, less the ones the interrupt canceled. */
export const countedOf = (cell: CellResult) =>
  Math.max(0, cell.passed + cell.failed - canceledOf(cell))

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
 * `not run`: no counted attempt reached the check, because an `expect.require` before it failed or
 * none counted. That is not a failure, and is never `0 of N`. `ran`: counts over the counted attempts that
 * reached it (`errored` ones couldn't answer), with `notRun` for those that didn't, and the
 * first failure's message and `path:line`.
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
      at: string | null
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
    const shown =
      answered.find((x) => x.status === 'fail') ?? answered.find((x) => x.status === 'error')
    const assertion = shown?.message ?? null
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
      labeledJudgments(a)
        .filter((j) => j.check === k.label)
        .map((j) => j.judgment),
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
              at: shown?.at ?? null,
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

function questionsOf(e: EvalEntry): Array<QuestionResult | AttemptQuestionResult> {
  const pairs = (e.answers ?? []).map(
    (a): QuestionResult => ({
      kind: 'pairs',
      question: a.question,
      votes: a.votes.length,
      rates: a.rates.map((r) => ({ cut: r.cut, name: r.name, wins: r.wins, n: r.n })),
      error: a.error ?? null,
    }),
  )
  const each = attemptAnswerRows(e).map((row): AttemptQuestionResult => {
    const failed = row.answers.filter((a) => a.error !== null)
    return {
      kind: 'attempts',
      question: row.question,
      asked: row.answers.length,
      choices: row.choices,
      answers: row.answers
        .filter((a) => a.error === null)
        .map((a) => ({ attempt: a.attempt, choice: a.choice, text: a.text })),
      failed: failed.length,
      error: failed[0]?.error ?? null,
    }
  })
  return [...pairs, ...each]
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
    const ran = e.attempts.filter((a) => a.cell === cell.key)
    const upstreams = tallyUpstreams(ran.flatMap((a) => a.upstreams ?? []))
    const judgeUpstreams = tallyUpstreams(
      ran.flatMap((a) =>
        a.judgements.flatMap((j) => (j.upstream ? [{ provider: j.upstream, calls: 1 }] : [])),
      ),
    )
    const lift = cell.lift
    const interval = lift ? { low: lift.interval.lo, high: lift.interval.hi } : null
    const snapshots = ran.flatMap((a) => {
      const final = a.outcome === 'fail' || a.outcome === 'infra_error'
      const path = final && a.snapshots?.find((s) => s.name === 'final')?.path
      return path ? [`.reeval/runs/${record.runId}/${path}`] : []
    })
    const pageErrors = ran.flatMap((a) =>
      (a.files.artifacts ?? []).flatMap(({ name, capture }) =>
        capture?.pageErrors && capture.page
          ? [
              {
                capture: name,
                errors: capture.pageErrors,
                file: `.reeval/runs/${record.runId}/${capture.page.path}`,
              },
            ]
          : [],
      ),
    )
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
      ...(cell.bestOf !== undefined
        ? {
            bestOf: cell.bestOf,
            notNeeded: ran.filter((a) => a.bestOf === 'skipped').length,
          }
        : {}),
      fingerprint: cell.fingerprint,
      context: contextOf(record, cell),
      checks: checksOf(e, cell, baseline, path, declared),
      effect: cell.role === 'variant' ? cellEffect(cell, baseline, interval) : null,
      interval,
      minLift: lift?.minLift ?? null,
      effort: effortOf(e, cell),
      effortDiffers: cell.role === 'variant' && effortDiffers(e, cell, baseline),
      errors: errorsOf(e, cell),
      ...(snapshots.length ? { snapshots } : {}),
      searches: attempts.map((a) => a.activity.webSearches),
      fetches: attempts.map((a) => a.activity.webFetches),
      ...(upstreams.length ? { upstreams } : {}),
      ...(judgeUpstreams.length ? { judgeUpstreams } : {}),
      ...(pageErrors.length ? { pageErrors } : {}),
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

/** Fail beats infra error, which beats canceled, which beats pass; skipped only when every one was. */
function worst(outcomes: ResultOutcome[]): ResultOutcome {
  if (outcomes.includes('fail')) return 'fail'
  if (outcomes.includes('infra_error')) return 'infra_error'
  if (outcomes.includes('canceled')) return 'canceled'
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

/** The record's outcome, or `canceled` when every gated attempt that failed was canceled. */
function outcomeOf(e: EvalEntry): ResultOutcome {
  if (e.outcome !== 'fail') return e.outcome
  const gated = new Set(e.cells.filter((c) => c.gate !== 'none').map((c) => c.key))
  const failed = e.attempts.filter((a) => a.outcome === 'fail' && gated.has(a.cell))
  return failed.length && failed.every((a) => a.error?.kind === 'aborted') ? 'canceled' : 'fail'
}

/** Each question any case asked, in first-asked order, with its votes or answers summed over the cases. */
function familyQuestions(
  cases: readonly EvalEntry[],
): Array<QuestionResult | AttemptQuestionResult> {
  const out = new Map<string, QuestionResult | AttemptQuestionResult>()
  for (const q of cases.flatMap(questionsOf)) {
    const key = `${q.kind}\0${q.question}`
    const have = out.get(key)
    if (!have) {
      out.set(
        key,
        q.kind === 'pairs'
          ? { ...q, rates: q.rates.map((r) => ({ ...r })) }
          : {
              ...q,
              choices: q.choices?.map((c) => ({ ...c })) ?? null,
              answers: [...q.answers],
            },
      )
      continue
    }
    have.error ??= q.error
    if (have.kind === 'attempts' && q.kind === 'attempts') {
      have.asked += q.asked
      have.failed += q.failed
      have.answers.push(...q.answers)
      for (const c of q.choices ?? []) {
        const same = have.choices?.find((x) => x.choice === c.choice)
        if (same) same.n += c.n
      }
      continue
    }
    if (have.kind !== 'pairs' || q.kind !== 'pairs') continue
    have.votes += q.votes
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
    observations: [],
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
    observations: observedTallies(e.attempts),
  }
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
    canceled: 0,
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
  }
}
