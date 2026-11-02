// The deterministic remarks: hard thresholds over one run's facts and, for the kinds that need
// it, the history's derived views. No model is involved. Pure: what the history and the eval's
// source say comes in through `RemarkContext`.
import { FLAKY_MIN_ATTEMPTS } from '../history/facts.ts'
import type { AttemptRecord, EvalEntry, RunRecord } from '../history/types.ts'
import { sha256 } from '../ids.ts'
import {
  COMPARE_RUNS,
  containsZero,
  familySmallSample,
  liftInterval,
  PAIRED_MIN,
  RUNS_TO_HOLD_MAX,
  runsToHold,
  runsToSettle,
  SMALL_SAMPLE_MARGIN,
  smallSample,
} from '../stats.ts'
import { clip } from '../text.ts'
import {
  boundOf,
  leanText,
  type Measure,
  measurePhrase,
  type Reading,
  tieOf,
} from '../view/measures.ts'
import type { Remark } from '../view/remarks.ts'
import type { CellResult, EvalResult, SuiteResult } from '../view/suite.ts'

/** check-never-fails: recorded default-branch runs in a row with no fail, and their tries. */
export const NEVER_FAILS_RUNS = 5
export const NEVER_FAILS_TRIES = 20
/** flaky-check: the newest comparable runs looked at, and how many must both pass and fail it. */
export const FLAKY_WINDOW = 5
export const FLAKY_RUNS = 2
/** slow-mcp-start: a stdio server this slow to answer `initialize`, in ms, or never. */
export const SLOW_MCP_MS = 2000

/** A remark before the run that first raised it is known. */
export type Candidate = Omit<Remark, 'firstSeenRun'>

/** A check's streak of clean recorded runs on the default branch (`check_streaks`). */
export type Streak = { runs: number; tries: number }
/** A check over a cell's newest comparable runs: runs that both passed and failed it, and its counts. */
export type CheckWindow = { runs: number; mixed: number; pass: number; fail: number }

/** What the rules read beyond the run: the history's views, and where text is in the eval's source. */
export type RemarkContext = {
  /** Null without history (no earlier run), or without a default branch for streaks. */
  history: {
    streak(evalKey: string, cellKey: string, label: string, fingerprint: string): Streak | null
    flaky(evalKey: string, cellKey: string, fingerprint: string): { cause: string } | null
    window(evalKey: string, cellKey: string, label: string, fingerprint: string): CheckWindow
  } | null
  /** A cell's fingerprint less agent runtime state, as the history pools runs on it. */
  comparable(entry: EvalEntry, cellKey: string): string
  /** `source:<file>#L<n>` of the first line naming `needle` in the eval's sources, else its file. */
  locate(entry: EvalEntry, needle: string | null): string
}

/** `KIND_ORDER` ranks remarks of one severity: the ones most worth acting on first. */
const KIND_ORDER: Remark['kind'][] = [
  'too-few-tries',
  'cant-tell-apart',
  'flaky-check',
  'slow-mcp-start',
  'proxy-only-egress',
  'setup-process-secret',
  'snapshot-too-large',
  'check-never-fails',
]

/** Remarks ranked: concerns first, then by kind, then in the order they came. */
export function rankRemarks<T extends Pick<Remark, 'severity' | 'kind'>>(remarks: T[]): T[] {
  const order = (r: T) => (r.severity === 'concern' ? 0 : 1) * 100 + KIND_ORDER.indexOf(r.kind)
  return remarks
    .map((r, i) => ({ r, i }))
    .sort((a, b) => order(a.r) - order(b.r) || a.i - b.i)
    .map(({ r }) => r)
}

/**
 * sha256(kind, eval, the eval's version[, what it's about]): one remark per kind per eval version.
 * The version is its `source` and `revision`, or its files on a record from before them.
 */
export function remarkId(kind: Remark['kind'], evalId: string, entry: EvalEntry, extra = '') {
  const sources = sha256(
    JSON.stringify(
      entry.source
        ? [entry.source, entry.revision ?? null]
        : entry.sources.map((s) => [s.path, s.sha256]),
    ),
  )
  return sha256(JSON.stringify([kind, evalId, sources, ...(extra ? [extra] : [])]))
}

const tries = (n: number) => `${n} ${n === 1 ? 'try' : 'tries'}`
const capital = (s: string) => `${s.slice(0, 1).toUpperCase()}${s.slice(1)}`
const rate = (c: CellResult) => (c.passed + c.failed ? c.passed / (c.passed + c.failed) : 0)
const counted = (c: CellResult) => c.passed + c.failed

/** An eval's units of cells: its own, or each family case's with that case's eval id. */
function units(e: EvalResult): Array<{ id: string; cells: CellResult[] }> {
  if (e.cases) return e.cases.map((k) => ({ id: k.id, cells: k.cells }))
  return [{ id: e.id, cells: e.cells ?? [] }]
}

const armOf = (c: CellResult) => c.variant ?? (c.environment === '-' ? 'baseline' : c.environment)

/** `evals/a.eval.ts:12` from `source:evals/a.eval.ts#L12`. */
const location = (at: string) => at.replace(/^source:/, '').replace(/#L(\d+)$/, ':$1')

const runs = (n: number) => `${n} ${n === 1 ? 'run' : 'runs'}`

/** Whether a variant's difference from its baseline holds: its interval excludes 0. */
function holds(variant: CellResult, base: CellResult): boolean {
  const { low, high } = liftInterval(
    { pass: variant.passed, n: counted(variant) },
    { pass: base.passed, n: counted(base) },
  )
  return !containsZero(low, high)
}

type Bound = 'pass' | 'fail'

/** `pass` when every side passed every counted run, `fail` when every side failed every one. */
const bounded = (cells: CellResult[]): Bound | null =>
  boundOf(cells.map((c) => ({ pass: c.passed, fail: c.failed })))

type Tie = { variant: CellResult; base: CellResult; bound: Bound }

type Look = { variant: CellResult; base: CellResult; reading: Reading & { told: 'leans' } }

const listed = (items: string[]) =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/**
 * ` It looks 12× faster, but 3 runs a side can't confirm it; 4 is the least that can.`: leans too
 * few runs can test, beside a pass-rate remark, which already counts the runs a rate needs.
 */
const shortLeans = (measures: readonly Measure[] | null | undefined) => {
  const short = (measures ?? []).filter(
    (m) => m.measure !== 'pass' && m.measure !== 'check' && m.short,
  )
  return short.length
    ? ` It ${listed(short.map((m) => leanText({ ...m, text: measurePhrase(m) })))}.`
    : ''
}

/** ` So far, marked runs 12× faster.`: `shortLeans` without the runs, for a remark's brief. */
const briefLeans = (variant: string, measures: readonly Measure[] | null | undefined) => {
  const short = (measures ?? []).filter(
    (m) => m.measure !== 'pass' && m.measure !== 'check' && m.short,
  )
  return short.length ? ` So far, ${variant} ${listed(short.map(measurePhrase))}.` : ''
}

/**
 * too-few-tries on a ceiling (concern): a variant and its baseline both passed every run and no
 * measure is better or worse, but some lean (`readMeasures`): the variant looks different, on too
 * few runs to say. It names the first such variant's leans, counting the others, and the runs (or
 * cases) at which the soonest would hold.
 */
function looksDifferent(
  e: EvalResult,
  entry: EvalEntry,
  ctx: RemarkContext,
  looks: Array<Look & { cases?: number }>,
): Candidate[] {
  const [first] = looks
  if (!first) return []
  const { variant, base, reading, cases } = first
  const harnesses = new Set(units(e).flatMap((u) => u.cells.map((c) => c.harness))).size > 1
  const on = harnesses ? ` on ${variant.harness}` : ''
  const others = looks.length - 1
  const more = others ? ` ${others} more ${others === 1 ? 'variant is' : 'variants are'} too.` : ''
  const counts = cases
    ? `over ${cases} ${cases === 1 ? 'case' : 'cases'}`
    : `${variant.passed} of ${counted(variant)} and ${base.passed} of ${counted(base)}`
  const { needed, unit } = reading
  const about =
    needed === null
      ? `even ${RUNS_TO_HOLD_MAX} ${unit} wouldn't confirm it`
      : unit === 'cases'
        ? `about ${needed} cases would confirm it`
        : `about ${runs(needed)} ${cases ? 'a case' : 'a side'} would confirm it`
  const text = `The ${armOf(variant)} variant${on} and the baseline passed every run (${counts}), but the variant looks different: ${listed(reading.measures.map(leanText))}; ${about}.${more}`
  const edit =
    needed === null
      ? "if a difference this faint doesn't matter, make the task harder, so the baseline can fail"
      : unit === 'cases'
        ? `add cases, to ${needed}, where the soonest of these would hold`
        : `set runs: ${needed}${cases ? ' a case' : ''}, where the soonest of these would hold`
  const at = ctx.locate(entry, null)
  const brief =
    needed === null
      ? undefined
      : `Both passed every run, but the variant looks different; ${unit === 'cases' ? `add cases, to ${needed},` : `set runs: ${needed}${cases ? ' a case' : ''}`} at ${location(at)} to confirm it.`
  return [
    {
      id: remarkId('too-few-tries', e.path, entry, 'looks'),
      evalId: e.path,
      kind: 'too-few-tries',
      severity: 'concern',
      text,
      ...(brief ? { brief } : {}),
      evidence: [variant.path, base.path],
      fix: { at, edit },
    },
  ]
}

/**
 * cant-tell-apart (concern): a variant and its baseline both passed every run, or both failed
 * every one, on at least `COMPARE_RUNS` runs a side (`PAIRED_MIN` cases for a family), and on a
 * ceiling every other measure of their comparison is the same (`tieOf`), so no number of runs can
 * tell them apart. Both passing means the task is too easy to show the change; both failing means
 * it may be too hard, or the eval broken, whatever else differs: a timeout counts as a fail, so
 * effort differs exactly when one arm hangs. It names the first such variant, counting the
 * others. Its id carries the bound, so a floor after a ceiling on the same source prints again.
 */
function cantTellApart(
  e: EvalResult,
  entry: EvalEntry,
  ctx: RemarkContext,
  ties: Array<Tie & { cases?: number }>,
): Candidate[] {
  const [tie] = ties
  if (!tie) return []
  const { variant, base, bound, cases } = tie
  const harnesses = new Set(units(e).flatMap((u) => u.cells.map((c) => c.harness))).size > 1
  const on = harnesses ? ` on ${variant.harness}` : ''
  const others = ties.length - 1
  const more = others ? ` ${others} more ${others === 1 ? 'variant is' : 'variants are'} too.` : ''
  const counts = cases
    ? `over ${cases} ${cases === 1 ? 'case' : 'cases'}`
    : `${variant.passed} of ${counted(variant)} and ${base.passed} of ${counted(base)}`
  const text =
    bound === 'pass'
      ? `The ${armOf(variant)} variant${on} and the baseline passed every run (${counts}): the task can't tell them apart, since both always pass.${more}`
      : `The ${armOf(variant)} variant${on} and the baseline failed every run (${counts}): the task may be too hard, or the eval broken.${more}`
  const edit =
    bound === 'pass'
      ? 'make the task harder, so the baseline can fail'
      : 'check the eval with an oracle (a fake agent that writes the solution); if it passes, make the task easier'
  return [
    {
      id: remarkId('cant-tell-apart', e.path, entry, bound),
      evalId: e.path,
      kind: 'cant-tell-apart',
      severity: 'concern',
      text,
      evidence: [variant.path, base.path],
      fix: { at: ctx.locate(entry, null), edit },
    },
  ]
}

/**
 * too-few-tries (concern): a variant's direction against its baseline doesn't hold yet. Their
 * pass rates differ but the interval on the difference spans 0, or the contrast is a small sample
 * (`smallSample`), whatever its direction: either side has fewer than `COMPARE_RUNS` runs, where
 * a difference whose interval excludes 0 can still be chance (when nothing changed, 2 of 2 against
 * 0 of 2 one way or the other comes up about 1 run in 8), or a `same` whose interval still reaches
 * past `SMALL_SAMPLE_MARGIN`. It names the variant with the widest gap, and the fix the runs a side
 * at which the observed rates would hold (`runsToHold`) or, for a `same`, settle (`runsToSettle`),
 * never fewer than `COMPARE_RUNS`. A tie where both sides always pass or always fail, on
 * `COMPARE_RUNS` runs a side or more, is `cantTellApart` instead, since runs can't break it; below
 * that, "always" rests on too few runs and stays here. A family is judged by its pooled lift
 * (`pooledTooFewTries`), not each case's.
 */
function tooFewTries(e: EvalResult, entry: EvalEntry, ctx: RemarkContext): Candidate[] {
  if (e.pooled) return pooledTooFewTries(e, entry, ctx)
  const weak: Array<{ variant: CellResult; base: CellResult; gap: number; held: boolean }> = []
  const ties: Tie[] = []
  const looks: Look[] = []
  for (const unit of units(e)) {
    for (const variant of unit.cells) {
      const base = unit.cells.find((c) => c.key === variant.vs)
      if (!variant.vs || !base || !counted(variant) || !counted(base)) continue
      const bound =
        Math.min(counted(variant), counted(base)) >= COMPARE_RUNS ? bounded([variant, base]) : null
      if (bound) {
        const tie = tieOf(bound, variant.measures)
        if (tie === 'tie') ties.push({ variant, base, bound })
        else if (tie?.told === 'leans') looks.push({ variant, base, reading: tie })
        continue
      }
      const gap = Math.abs(rate(variant) - rate(base))
      const held = gap > 0 && holds(variant, base)
      const small = smallSample(
        { pass: variant.passed, n: counted(variant) },
        { pass: base.passed, n: counted(base) },
      )
      if (!small && (gap === 0 || held)) continue
      weak.push({ variant, base, gap, held })
    }
  }
  const apart = [...cantTellApart(e, entry, ctx, ties), ...looksDifferent(e, entry, ctx, looks)]
  const worst = [...weak].sort((a, b) => b.gap - a.gap)[0]
  if (!worst) return apart
  const { variant, base, gap, held } = worst
  const harnesses = new Set(units(e).flatMap((u) => u.cells.map((c) => c.harness))).size > 1
  const on = harnesses ? ` on ${variant.harness}` : ''
  const counts = `The ${armOf(variant)} variant${on} passed ${variant.passed} of ${runs(counted(variant))} and the baseline ${base.passed} of ${counted(base)}`
  const others = weak.length - 1
  const more = others ? ` ${others} more ${others === 1 ? 'variant is' : 'variants are'} too.` : ''
  const side = Math.max(counted(variant), counted(base))
  const from = Math.max(side + 1, COMPARE_RUNS)
  const needed = gap
    ? runsToHold(rate(variant), rate(base), from)
    : runsToSettle(rate(variant), rate(base), from)
  const { low, high } = liftInterval(
    { pass: variant.passed, n: counted(variant) },
    { pass: base.passed, n: counted(base) },
  )
  const reach = Math.round(Math.max(-low, high) * 100)
  const margin = Math.round(SMALL_SAMPLE_MARGIN * 100)
  const direction = rate(variant) > rate(base) ? 'better' : 'worse'
  const fewest = runs(Math.min(counted(variant), counted(base)))
  const also = shortLeans(variant.measures)
  const text = held
    ? `${counts}: ${direction} by ${Math.round(gap * 100)} points, on only ${fewest} a side.${also}${more}`
    : gap
      ? `${counts}: ${direction} by ${Math.round(gap * 100)} points, but on too few runs for the difference to hold.${also}${more}`
      : `${counts}: the same, but ${fewest} a side can't rule out a difference of up to ${reach} points.${also}${more}`
  const edit = held
    ? `set runs: ${COMPARE_RUNS} or more, so a split this wide is less likely by chance`
    : !gap
      ? `set runs: ${needed}, where the same rates would rule out ${margin} points either way`
      : needed
        ? `set runs: ${needed}, where a difference this size would hold`
        : `a difference this size doesn't hold even at runs: ${RUNS_TO_HOLD_MAX}`
  const at = ctx.locate(entry, null)
  const these = others || also ? 'these differences' : 'this difference'
  const per = `${fewest} per side; set runs:`
  const lead = held
    ? `${per} ${COMPARE_RUNS} at ${location(at)}, so a split this wide is less likely by chance.`
    : !gap
      ? `${per} ${needed} at ${location(at)} to rule out a difference.`
      : needed
        ? `${per} ${needed} at ${location(at)} to confirm ${these}.`
        : undefined
  const brief = lead && `${lead}${briefLeans(armOf(variant), variant.measures)}`
  return [
    ...apart,
    {
      id: remarkId('too-few-tries', e.path, entry),
      evalId: e.path,
      kind: 'too-few-tries',
      severity: 'concern',
      text,
      ...(brief ? { brief } : {}),
      evidence: [variant.path, base.path],
      fix: { at, edit },
    },
  ]
}

/**
 * too-few-tries on a family: its pooled lift is the result for its cases, so it's raised when
 * that lift doesn't hold (`insufficient` below `PAIRED_MIN` discordant pairs or cases, or within
 * noise) and either differs or rests on a small sample (`familySmallSample`). Many cases that all
 * agree are `insufficient` but settled, and raise nothing. A tie where every case on both sides
 * passed, or every one failed, over `PAIRED_MIN` cases or more, is `cantTellApart` instead.
 */
function pooledTooFewTries(e: EvalResult, entry: EvalEntry, ctx: RemarkContext): Candidate[] {
  const cells = (e.cases ?? []).flatMap((k) => k.cells)
  const ties: Array<Tie & { cases: number }> = []
  const looks: Array<Look & { cases: number }> = []
  const weak = (e.pooled ?? []).filter((p) => {
    const own = cells.filter((c) => c.key === p.key)
    const bases = cells.filter((c) => own.some((v) => v.vs === c.key))
    const bound = p.effect === 'same' && p.pairs >= PAIRED_MIN ? bounded([...own, ...bases]) : null
    const [variant] = own
    const [base] = bases
    if (bound && variant && base) {
      const tie = tieOf(bound, p.measures)
      if (tie === 'tie') ties.push({ variant, base, bound, cases: p.pairs })
      else if (tie?.told === 'leans') looks.push({ variant, base, reading: tie, cases: p.pairs })
      return false
    }
    return (
      (p.verdict === 'insufficient' || p.verdict === 'noise') &&
      (p.effect !== 'same' || familySmallSample(p.pairs, p.interval.low, p.interval.high))
    )
  })
  const apart = [...cantTellApart(e, entry, ctx, ties), ...looksDifferent(e, entry, ctx, looks)]
  const [arm] = weak
  if (!arm) return apart
  const variant = cells.find((c) => c.key === arm.key)
  const harnesses = new Set(cells.map((c) => c.harness)).size > 1
  const on = harnesses && variant ? ` on ${variant.harness}` : ''
  const others = weak.length - 1
  const more = others ? ` ${others} more ${others === 1 ? 'variant is' : 'variants are'} too.` : ''
  const direction = arm.effect === 'same' ? 'the same' : arm.effect
  const few = arm.verdict === 'insufficient'
  const reach = Math.round(Math.max(-arm.interval.low, arm.interval.high) * 100)
  const why = few
    ? `a family's lift needs ${PAIRED_MIN} to hold`
    : arm.effect === 'same'
      ? `it can't rule out a difference of up to ${reach} points`
      : "the difference doesn't hold"
  const text = `The ${variant ? armOf(variant) : arm.key} variant${on}, pooled over ${arm.pairs} ${arm.pairs === 1 ? 'case' : 'cases'}: ${direction}, but ${why}.${shortLeans(arm.measures)}${more}`
  return [
    ...apart,
    {
      id: remarkId('too-few-tries', e.path, entry),
      evalId: e.path,
      kind: 'too-few-tries',
      severity: 'concern',
      text,
      evidence: [arm.path],
      fix: {
        at: ctx.locate(entry, null),
        edit: few
          ? `add cases, so the pooled lift has ${PAIRED_MIN} to hold on`
          : arm.effect === 'same'
            ? `add cases, or set runs: ${COMPARE_RUNS} or more a case, so the pooled interval narrows`
            : `add cases, or set runs: ${COMPARE_RUNS} or more a case, so the difference can hold`,
      },
    },
  ]
}

/** The record's tally of a check in a cell, with its variant verdict. */
const recordCheck = (entry: EvalEntry, cellKey: string, label: string) =>
  entry.cells.find((c) => c.key === cellKey)?.checks?.find((k) => k.label === label)

/**
 * check-never-fails (suggestion): in every cell of the eval, a check passed this run with no fail,
 * and its streak (`check_streaks`) on the default branch is at least `NEVER_FAILS_RUNS` recorded
 * runs and `NEVER_FAILS_TRIES` tries on the same setup; on a variant, it passed on both sides.
 */
function checkNeverFails(
  e: EvalResult,
  entries: (id: string) => EvalEntry | undefined,
  ctx: RemarkContext,
): Candidate[] {
  const history = ctx.history
  if (!history) return []
  const all = units(e)
  const labels = [
    ...new Set(all.flatMap((u) => u.cells.flatMap((c) => c.checks.map((k) => k.label)))),
  ]
  const found: Array<{ label: string; runs: number; tries: number; paths: string[] }> = []
  for (const label of labels) {
    let runs = Number.POSITIVE_INFINITY
    let total = Number.POSITIVE_INFINITY
    const paths: string[] = []
    const ok = all.every((u) => {
      const entry = entries(u.id)
      return (
        entry &&
        u.cells.every((cell) => {
          const k = cell.checks.find((x) => x.label === label)
          if (k?.outcome.status !== 'ran') return false
          if (k.outcome.failed || k.outcome.errored || !k.outcome.passed) return false
          if (cell.vs && recordCheck(entry, cell.key, label)?.verdict !== 'both-pass') return false
          const s = history.streak(u.id, cell.key, label, ctx.comparable(entry, cell.key))
          if (!s || s.runs < NEVER_FAILS_RUNS || s.tries < NEVER_FAILS_TRIES) return false
          runs = Math.min(runs, s.runs)
          total = Math.min(total, s.tries)
          paths.push(k.path)
          return true
        })
      )
    })
    if (ok && paths.length) found.push({ label, runs, tries: total, paths })
  }
  const [first] = found
  const entry = entries(all[0]?.id ?? '')
  if (!first || !entry) return []
  const compare = all.some((u) => u.cells.some((c) => c.vs))
  const more = found.length > 1 ? ` (and ${found.length - 1} more)` : ''
  const text = compare
    ? `"${first.label}"${more} passed with and without the change in each of the last ${first.runs} recorded runs, so it doesn't show a difference.`
    : `"${first.label}"${more} passed every try in the last ${first.runs} recorded runs (${first.tries} tries), so it never tells a good result from a bad one.`
  return [
    {
      id: remarkId('check-never-fails', e.path, entry),
      evalId: e.path,
      kind: 'check-never-fails',
      severity: 'suggestion',
      text,
      evidence: found.flatMap((f) => f.paths),
      fix: {
        at: ctx.locate(entry, first.label),
        edit: compare
          ? `make "${first.label}" check what the change affects, or remove it`
          : `make "${first.label}" strict enough to fail on a wrong result, or remove it`,
      },
    },
  ]
}

/**
 * flaky-check (concern): the cell is `flaky` in `flaky_cells` (at least `FLAKY_MIN_ATTEMPTS`
 * counted tries over comparable runs, not from infrastructure), and the check both passed and
 * failed in at least `FLAKY_RUNS` of the cell's newest `FLAKY_WINDOW` runs on the same setup.
 */
function flakyCheck(
  e: EvalResult,
  entries: (id: string) => EvalEntry | undefined,
  ctx: RemarkContext,
): Candidate[] {
  const history = ctx.history
  if (!history) return []
  const found: Array<{ label: string; window: CheckWindow; path: string; entry: EvalEntry }> = []
  for (const u of units(e)) {
    const entry = entries(u.id)
    if (!entry) continue
    for (const cell of u.cells) {
      const fingerprint = ctx.comparable(entry, cell.key)
      const flaky = history.flaky(u.id, cell.key, fingerprint)
      if (!flaky || flaky.cause === 'infra') continue
      for (const k of cell.checks) {
        if (k.outcome.status !== 'ran' || found.some((f) => f.label === k.label)) continue
        const window = history.window(u.id, cell.key, k.label, fingerprint)
        if (window.mixed >= FLAKY_RUNS && window.pass + window.fail >= FLAKY_MIN_ATTEMPTS) {
          found.push({ label: k.label, window, path: k.path, entry })
        }
      }
    }
  }
  const [first] = found
  if (!first) return []
  const { window: w } = first
  const more = found.length > 1 ? ` (and ${found.length - 1} more)` : ''
  return [
    {
      id: remarkId('flaky-check', e.path, first.entry),
      evalId: e.path,
      kind: 'flaky-check',
      severity: 'concern',
      text: `"${first.label}"${more} passed ${w.pass} of ${tries(w.pass + w.fail)} over ${w.runs} runs with nothing changed, so one try can pass or fail it.`,
      evidence: found.map((f) => f.path),
      fix: {
        at: ctx.locate(first.entry, first.label),
        edit: `make "${first.label}" check something every good try does, or raise runs so one try doesn't decide it`,
      },
    },
  ]
}

/** `<plugin>:<server>` is a plugin's server; any other name is a plain `mcp` one. */
function serverName(server: string): string {
  const at = server.indexOf(':')
  return at > 0
    ? `the ${server.slice(0, at)} plugin's MCP server ${server.slice(at + 1)}`
    : `MCP server ${server}`
}

/** `4s` from 4000 ms, `2.4s` from 2400, whole seconds from 10s. */
const seconds = (ms: number) => {
  const s = Math.round(ms / 100) / 10
  return `${s >= 10 ? Math.round(s) : s}s`
}

const slow = (ms: number | null) => ms === null || ms >= SLOW_MCP_MS

/**
 * slow-mcp-start (concern): a stdio MCP server took `SLOW_MCP_MS` or more to answer `initialize`,
 * or never answered, on some turn. One per server, over the eval's attempts. A harness that starts
 * its servers once a session records them on its first turn only, so the turns counted are the
 * ones that recorded the server.
 */
function slowMcpStart(e: EvalResult, entries: EvalEntry[], ctx: RemarkContext): Candidate[] {
  const cellPaths = new Map<string, string>()
  for (const u of units(e)) for (const c of u.cells) cellPaths.set(`${u.id}\0${c.key}`, c.path)
  const attempts: Array<{ entry: EvalEntry; attempt: AttemptRecord }> = entries.flatMap((entry) =>
    entry.attempts.map((attempt) => ({ entry, attempt })),
  )
  const servers = [
    ...new Set(
      attempts.flatMap(({ attempt }) =>
        attempt.turns.flatMap((t) => (t.mcpStartup ?? []).map((m) => m.server)),
      ),
    ),
  ]
  const out: Candidate[] = []
  for (const server of servers) {
    type Hit = {
      entry: EvalEntry
      attempt: AttemptRecord
      ms: number[]
      never: boolean
      turns: number
      slowTurns: number
    }
    const recorded: Hit[] = []
    for (const { entry, attempt } of attempts) {
      const turns = attempt.turns
        .map((t) => (t.mcpStartup ?? []).filter((m) => m.server === server))
        .filter((starts) => starts.length > 0)
      if (!turns.length) continue
      const slowTurns = turns.filter((starts) => starts.some((m) => slow(m.ms))).length
      const starts = turns.flat()
      recorded.push({
        entry,
        attempt,
        ms: starts.flatMap((m) => (m.ms !== null && m.ms >= SLOW_MCP_MS ? [m.ms] : [])),
        never: starts.some((m) => m.ms === null),
        turns: turns.length,
        slowTurns,
      })
    }
    const hits = recorded.filter((h) => h.slowTurns > 0)
    const worst = [...hits].sort(
      (a, b) => Number(b.never) - Number(a.never) || Math.max(0, ...b.ms) - Math.max(0, ...a.ms),
    )[0]
    if (!worst) continue
    const first = hits[0] as Hit
    const what = worst.never
      ? `${serverName(server)} never answered within the start-up timeout`
      : `${serverName(server)} took ${seconds(Math.max(...worst.ms))} to start`
    const turns =
      worst.turns > 1
        ? worst.slowTurns === worst.turns
          ? ` on each of ${worst.turns} turns`
          : ` on ${worst.slowTurns} of ${worst.turns} turns`
        : ''
    const ofTries = recorded.length > 1 ? `, in ${hits.length} of ${recorded.length} tries` : ''
    const name = server.includes(':') ? server.slice(0, server.indexOf(':')) : server
    out.push({
      id: remarkId('slow-mcp-start', e.path, first.entry, server),
      evalId: e.path,
      kind: 'slow-mcp-start',
      severity: 'concern',
      text: `${capital(what)}${turns}${ofTries}.`,
      evidence: hits.map(
        (h) => `${cellPaths.get(`${h.entry.id}\0${h.attempt.cell}`) ?? h.entry.id}#${h.attempt.n}`,
      ),
      fix: {
        at: ctx.locate(first.entry, name),
        edit: worst.never
          ? `run ${server}'s command in the sandbox with c.exec to see why it doesn't answer initialize`
          : `install what ${server} needs in the image (install or dockerfile), so it doesn't fetch or build it at start-up`,
      },
    })
  }
  return out
}

/**
 * What a client prints when it can't connect, resolve a name or find a route: under `proxy` the
 * sandbox has no network of its own, so a client that ignores the proxy fails with one of these.
 */
const CONNECTION_ERROR =
  /\b(?:ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)\b|network is unreachable|no route to host|connection refused|could not resolve host|temporary failure in name resolution|name or service not known|could not translate host name|getaddrinfo/i

/** The record's text an attempt failed with: its error, failed assertions and turns. */
const failureText = (a: AttemptRecord) => [
  a.error?.message ?? '',
  ...(a.assertions ?? []).filter((x) => x.status !== 'pass').map((x) => x.message ?? ''),
  ...a.turns.flatMap((t) => [t.text, t.error ?? '']),
]

/**
 * proxy-only-egress (concern): an attempt under `proxy` failed with a connection error, and the
 * gateway neither refused nor failed to resolve anything, so the connection never reached it: a raw TCP or UDP client (SSH, a
 * database driver), or one that ignores `HTTPS_PROXY`. One per eval.
 */
function proxyOnlyEgress(e: EvalResult, entries: EvalEntry[], ctx: RemarkContext): Candidate[] {
  const cellPaths = new Map<string, string>()
  for (const u of units(e)) for (const c of u.cells) cellPaths.set(`${u.id}\0${c.key}`, c.path)
  const hits = entries.flatMap((entry) =>
    entry.attempts.flatMap((attempt) => {
      if (attempt.outcome !== 'fail' && attempt.outcome !== 'infra_error') return []
      const egress = attempt.egress
      if (egress?.policy !== 'proxy' || !egress.recorded) return []
      if (egress.blocked.length || egress.unresolved.length) return []
      const error = failureText(attempt)
        .map((t) => CONNECTION_ERROR.exec(t)?.[0])
        .find(Boolean)
      return error ? [{ entry, attempt, error }] : []
    }),
  )
  const [first] = hits
  if (!first) return []
  const ofTries = hits.length > 1 ? ` (${hits.length} tries)` : ''
  const at = ctx.locate(first.entry, null)
  return [
    {
      id: remarkId('proxy-only-egress', e.path, first.entry),
      evalId: e.path,
      kind: 'proxy-only-egress',
      severity: 'concern',
      text: `It failed with "${first.error}"${ofTries} and nothing reached the egress gateway: under egress 'proxy' only HTTP(S) through the gateway leaves the sandbox, so raw TCP, UDP, SSH and database connections fail.`,
      brief: `Only HTTP(S) leaves under egress 'proxy'; set egress: 'allow-all' at ${location(at)} for raw TCP or UDP.`,
      evidence: hits.map(
        (h) => `${cellPaths.get(`${h.entry.id}\0${h.attempt.cell}`) ?? h.entry.id}#${h.attempt.n}`,
      ),
      fix: {
        at,
        edit: "set egress: 'allow-all' on the eval if it needs raw TCP or UDP, or point the client at HTTPS_PROXY",
      },
    },
  ]
}

/**
 * setup-process-secret (concern): a setup step left a process running with a `to: 'checks'` secret
 * without `hosts` in its environment (`setupProcesses`), so it holds the real value while the agent,
 * as the same user, works beside it. One per eval.
 */
function setupProcessSecret(e: EvalResult, entries: EvalEntry[], ctx: RemarkContext): Candidate[] {
  const cellPaths = new Map<string, string>()
  for (const u of units(e)) for (const c of u.cells) cellPaths.set(`${u.id}\0${c.key}`, c.path)
  const hits = entries.flatMap((entry) =>
    entry.attempts.flatMap((attempt) =>
      attempt.setupProcesses?.length ? [{ entry, attempt, processes: attempt.setupProcesses }] : [],
    ),
  )
  const [first] = hits
  if (!first) return []
  const secrets = [...new Set(hits.flatMap((h) => h.processes.flatMap((p) => p.secrets)))]
  const commands = [...new Set(hits.flatMap((h) => h.processes.map((p) => p.command)))]
  const more = commands.length > 1 ? ` (and ${commands.length - 1} more)` : ''
  const ofTries = hits.length > 1 ? ` in ${hits.length} tries` : ''
  const [secret = ''] = secrets
  const list = secrets.join(', ')
  const which = secrets.length > 1 ? "to: 'checks' secrets" : "a to: 'checks' secret"
  const [its, those] = commands.length > 1 ? ['their', 'those processes'] : ['its', 'that process']
  return [
    {
      id: remarkId('setup-process-secret', e.path, first.entry),
      evalId: e.path,
      kind: 'setup-process-secret',
      severity: 'concern',
      text: `Setup left "${clip(commands[0] ?? '', 80)}"${more} running with ${list}, ${which} without hosts, in ${its} environment${ofTries}, so the agent can read the real value from ${those}.`,
      evidence: hits.map(
        (h) => `${cellPaths.get(`${h.entry.id}\0${h.attempt.cell}`) ?? h.entry.id}#${h.attempt.n}`,
      ),
      fix: {
        at: ctx.locate(first.entry, secret),
        edit: `broker ${secret} with the hosts the process sends it to, e.g. secret({ to: 'checks', hosts: ['api.example.com'] }), so it holds a placeholder, or start the process from c.exec after the agent's turn`,
      },
    },
  ]
}

/**
 * snapshot-too-large (concern): an attempt's workspace was over its snapshot form's cap, without
 * its dependency and cache directories, so reeval took no snapshot of it. One per eval.
 */
function snapshotTooLarge(e: EvalResult, entries: EvalEntry[], ctx: RemarkContext): Candidate[] {
  const cellPaths = new Map<string, string>()
  for (const u of units(e)) for (const c of u.cells) cellPaths.set(`${u.id}\0${c.key}`, c.path)
  const hits = entries.flatMap((entry) =>
    entry.attempts.flatMap((attempt) => {
      const over = attempt.snapshots?.find((s) => s.skipped?.cause === 'size')
      return over ? [{ entry, attempt, over }] : []
    }),
  )
  const [first] = hits
  if (!first) return []
  const tried = entries.reduce(
    (n, entry) => n + entry.attempts.filter((a) => a.snapshots?.length).length,
    0,
  )
  const ofTries = tried > 1 ? ` in ${hits.length} of ${tried} tries` : ''
  const larger =
    first.over.form === 'dir' ? ', set snapshot: { compress: true } for the larger cap' : ''
  return [
    {
      id: remarkId('snapshot-too-large', e.path, first.entry),
      evalId: e.path,
      kind: 'snapshot-too-large',
      severity: 'concern',
      text: `reeval took no ${first.over.name} snapshot${ofTries}: ${first.over.skipped?.message}.`,
      evidence: hits.map(
        (h) => `${cellPaths.get(`${h.entry.id}\0${h.attempt.cell}`) ?? h.entry.id}#${h.attempt.n}`,
      ),
      fix: {
        at: ctx.locate(first.entry, null),
        edit: `have the task leave generated files in a directory reeval leaves out (node_modules/, .cache/)${larger}, or set snapshot: false on the eval`,
      },
    },
  ]
}

/** Every deterministic remark the run raises, ranked: concerns first, then by kind and eval. */
export function deterministicRemarks(
  suite: SuiteResult,
  record: RunRecord,
  ctx: RemarkContext,
): Candidate[] {
  const byId = new Map(record.evals.map((e) => [e.id, e]))
  const entries = (id: string) => byId.get(id)
  const out: Candidate[] = []
  for (const file of suite.files) {
    for (const e of [...file.evals].sort((a, b) => a.order - b.order)) {
      if (e.todo || e.outcome === 'skipped') continue
      const own = units(e).flatMap((u) => entries(u.id) ?? [])
      const first = own[0]
      if (!first) continue
      out.push(
        ...flakyCheck(e, entries, ctx),
        ...slowMcpStart(e, own, ctx),
        ...proxyOnlyEgress(e, own, ctx),
        ...setupProcessSecret(e, own, ctx),
        ...snapshotTooLarge(e, own, ctx),
        ...tooFewTries(e, first, ctx),
        ...checkNeverFails(e, entries, ctx),
      )
    }
  }
  return rankRemarks(out)
}
