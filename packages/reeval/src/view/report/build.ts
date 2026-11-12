import { caseName } from '../../history/cases.ts'
import type { AttemptRecord, CellRecord, EvalEntry, RunRecord } from '../../history/types.ts'
import { COMPARE_RUNS, containsZero, liftInterval } from '../../stats.ts'
import type { CapturePageFile } from '../../types.ts'
import { totalTokens } from '../../usage.ts'
import type { AnalysisDoc } from '../analysis.ts'
import type { CompareRow, StackChange } from '../compare.ts'
import { contrastsOf } from '../contrasts.ts'
import { runCost } from '../cost.ts'
import { effortSample, filesChanged, formatCount, formatSeconds } from '../effort.ts'
import { labeledJudgments } from '../judgments.ts'
import { attemptAnswerRows, isUngatedMiss } from '../model.ts'
import type { RunRemarks } from '../remarks.ts'
import { factSegment, messageLine } from '../suite.ts'
import { turnErrorKind } from '../turn-error.ts'
import {
  countFigure,
  countOf,
  diffLinesText,
  durationFigure,
  pctDelta,
  ptsDelta,
  ptsInterval,
  rateOf,
  spreadOf,
  tokensFigure,
  tokensText,
  usdFigure,
} from './format.ts'
import { type AttemptIdMap, attemptIds, selectedEvals } from './ids.ts'
import { measurePhrase, PASS_RATE_OUTCOME_LABEL, passRateOutcomeFromMatchers } from './labels.ts'
import { attemptHref, attemptRef, captureHref, gfmAnchor, withBase } from './links.ts'
import { REPORT_POLICY } from './policy.ts'
import { provenanceState } from './provenance.ts'
import type {
  Arm,
  ArmRef,
  ArmRow,
  AssertionRow,
  AttemptIndexRow,
  AttemptRef,
  BreakdownRow,
  CaptureGallery,
  ChangeRow,
  CheckCell,
  ChoiceBreakdown,
  ContrastRow,
  DiscoveryRate,
  EvalHeadline,
  EvalSection,
  EvalShape,
  ExecutiveRollup,
  FailureClusters,
  Fairness,
  Figure,
  HeadlinePrimary,
  IntegrityIssue,
  JudgmentBreakdown,
  MeasureCells,
  MeasureKey,
  MeasureVsBaseline,
  QualitativeAnswers,
  Quote,
  Rate,
  RegressionChanges,
  ReportClaim,
  RosterRow,
  RunHeader,
  RunReport,
  RunTally,
  Spread,
  TaskResults,
  VariantComparison,
} from './types.ts'

export type RunReportOptions = {
  remarks?: RunRemarks | null
  analysis?: AnalysisDoc | null
  /** `.capture.json` files read beside the record, by `ArtifactRef.capture.page.path`. */
  pages?: ReadonlyMap<string, CapturePageFile>
  prior?: { record: RunRecord; rows: CompareRow[]; changes: StackChange[] } | null
  /** Limits the report to these `EvalEntry.key`s; one key gives a single-eval report. */
  evals?: string[]
  /** Overrides the derived title. */
  title?: string
  /** Where the report's links point. */
  links?: ReportLinks
}

/** Where a report's links point, for a host that serves a run's files elsewhere than its folder. */
export type ReportLinks = {
  /** Prefix of every artifact link, which is relative to the run's folder. `./` in `summary.md`. */
  base?: string
  /** The run record's href. `../<runId>.json`, the record beside the run's folder, by default. */
  record?: string
}

const MEASURE_KEYS: MeasureKey[] = [
  'tokens',
  'toolCalls',
  'turns',
  'costUsd',
  'agentMs',
  'filesChanged',
  'linesAdded',
  'linesRemoved',
]

const LOCKFILE_NAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'pubspec.lock',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'Podfile.lock',
  'gradle.lockfile',
])

const isLockfilePath = (path: string) => LOCKFILE_NAMES.has(path.split('/').pop() ?? path)

const countedOutcome = (o: AttemptRecord['outcome']) => o === 'pass' || o === 'fail'

const cellOf = (e: EvalEntry, key: string) => e.cells.find((c) => c.key === key)

function assignAttemptHrefs(ctx: Ctx): void {
  for (const e of ctx.evals) {
    for (const a of e.attempts) {
      if (a.seq === null) continue
      const id = ctx.ids.get(a.key)
      if (!id) continue
      const href = attemptHref(e, a, id, ctx.linkBase, ctx.hrefs)
      ctx.hrefByKey.set(a.key, href)
    }
  }
}

const repoBasename = (remote: string | null | undefined): string | null => {
  if (!remote) return null
  const cleaned = remote.replace(/\.git$/, '')
  const slash = cleaned.lastIndexOf('/')
  const colon = cleaned.lastIndexOf(':')
  const at = Math.max(slash, colon)
  return at === -1 ? cleaned : cleaned.slice(at + 1) || null
}

function emptyMeasures(): MeasureCells {
  return {
    tokens: null,
    toolCalls: null,
    turns: null,
    costUsd: null,
    agentMs: null,
    filesChanged: null,
    linesAdded: null,
    linesRemoved: null,
  }
}

function emptyMeasureVsBaseline(): Record<MeasureKey, MeasureVsBaseline> {
  const blank = (): MeasureVsBaseline => ({ value: null, delta: null, lower: null })
  return {
    tokens: blank(),
    toolCalls: blank(),
    turns: blank(),
    costUsd: blank(),
    agentMs: blank(),
    filesChanged: blank(),
    linesAdded: blank(),
    linesRemoved: blank(),
  }
}

/** Diff line totals for an attempt; lockfiles excluded. Null counts when not recorded. */
function attemptDiffStats(a: AttemptRecord): {
  files: number
  added: number | null
  removed: number | null
} {
  const files = filesChanged(a.changedFiles)
  const withLines = a.changedFiles.filter((f) => {
    const row = f as { added?: number; removed?: number; lockfile?: boolean }
    return (
      !isLockfilePath(f.path) &&
      !row.lockfile &&
      (row.added !== undefined || row.removed !== undefined)
    )
  })
  if (withLines.length === 0) {
    // Older records: no per-file line stats on changedFiles.
    return { files, added: null, removed: null }
  }
  let added = 0
  let removed = 0
  for (const f of a.changedFiles) {
    const row = f as { added?: number; removed?: number; lockfile?: boolean }
    if (isLockfilePath(f.path) || row.lockfile) continue
    added += row.added ?? 0
    removed += row.removed ?? 0
  }
  return { files, added, removed }
}

function measureValues(attempts: AttemptRecord[]): Record<MeasureKey, number[]> {
  const out: Record<MeasureKey, number[]> = {
    tokens: [],
    toolCalls: [],
    turns: [],
    costUsd: [],
    agentMs: [],
    filesChanged: [],
    linesAdded: [],
    linesRemoved: [],
  }
  for (const a of attempts) {
    if (!countedOutcome(a.outcome)) continue
    const sample = effortSample(a)
    if (sample.tokens !== undefined) out.tokens.push(sample.tokens)
    out.toolCalls.push(sample.tools)
    out.turns.push(a.turns.length)
    if (sample.usd !== undefined) out.costUsd.push(sample.usd)
    out.agentMs.push(sample.agentMs)
    out.filesChanged.push(sample.filesChanged)
    const diff = attemptDiffStats(a)
    if (diff.added !== null) out.linesAdded.push(diff.added)
    if (diff.removed !== null) out.linesRemoved.push(diff.removed)
  }
  return out
}

function measuresOf(attempts: AttemptRecord[]): MeasureCells {
  const values = measureValues(attempts)
  const fmt: Record<MeasureKey, (n: number) => string> = {
    tokens: tokensText,
    toolCalls: formatCount,
    turns: formatCount,
    costUsd: (n) => usdFigure(n).text,
    agentMs: formatSeconds,
    filesChanged: formatCount,
    linesAdded: formatCount,
    linesRemoved: formatCount,
  }
  const cells = emptyMeasures()
  for (const key of MEASURE_KEYS) {
    cells[key] = spreadOf(values[key], fmt[key])
  }
  return cells
}

function measureVs(
  value: Spread | null,
  baseline: Spread | null,
  lower: { k: number; n: number } | null,
): MeasureVsBaseline {
  if (!value) return { value: null, delta: null, lower: null }
  const delta =
    baseline && baseline.median.value !== null && value.median.value !== null
      ? pctDelta(value.median.value, baseline.median.value)
      : null
  return {
    value,
    delta,
    lower: lower ? countOf(lower.k, lower.n) : null,
  }
}

type Ctx = {
  record: RunRecord
  evals: EvalEntry[]
  ids: AttemptIdMap
  linkBase?: string
  remarks: RunRemarks | null
  analysis: AnalysisDoc | null
  pages?: ReadonlyMap<string, CapturePageFile>
  prior: RunReportOptions['prior']
  /** Citation hrefs already claimed in this report; keeps per-arm evidence distinct. */
  hrefs: Set<string>
  /** Canonical evidence href per attempt key, assigned before section cites. */
  hrefByKey: Map<string, string>
}

function deriveTally(evals: EvalEntry[]): RunTally {
  let passed = 0
  let failed = 0
  let ungatedPassed = 0
  let ungatedFailed = 0
  let infraError = 0
  let reclassified = 0
  let skipped = 0
  for (const e of evals) {
    for (const a of e.attempts) {
      const cell = cellOf(e, a.cell)
      const ungated = cell?.gate === 'none'
      if (a.outcome === 'skipped') {
        skipped++
        continue
      }
      if (a.outcome === 'infra_error') {
        infraError++
        if (wasReclassified(a)) reclassified++
        continue
      }
      if (a.outcome === 'pass') {
        if (ungated) ungatedPassed++
        else passed++
        continue
      }
      if (a.outcome === 'fail') {
        if (ungated || isUngatedMiss(e, a)) ungatedFailed++
        else failed++
      }
    }
  }
  return {
    counted: passed + failed,
    passed,
    failed,
    ungated: { passed: ungatedPassed, failed: ungatedFailed },
    infraError,
    reclassified,
    skipped,
  }
}

/** Older records: a turn error on a pass/fail attempt is treated as reclassified. */
function wasReclassified(a: AttemptRecord): boolean {
  if ((a as { turnStatusRead?: boolean }).turnStatusRead === true) return false
  if (a.error && 'turn' in a.error && (a.error as { turn?: unknown }).turn) return true
  return a.turns.some((t) => t.status === 'error') && countedOutcome(a.outcome)
}

function turnErrorMessage(a: AttemptRecord): string | null {
  const turn = a.turns.find((t) => t.status === 'error' && t.error)
  if (!turn?.error) return null
  return `${turnErrorKind(turn.error)}: ${messageLine(turn.error)}`
}

function runTitle(record: RunRecord, evals: EvalEntry[], title?: string): string {
  if (title) return title
  if (evals.length === 1) return evals[0]!.name
  const groups = evals.map((e) => e.group[0]).filter(Boolean)
  if (groups.length === evals.length && new Set(groups).size === 1) return groups[0] as string
  return `Run ${record.runId}`
}

function runsPerCell(evals: EvalEntry[]): number | null {
  const runs = new Set(evals.flatMap((e) => e.cells.map((c) => c.runs)))
  return runs.size === 1 ? ([...runs][0] ?? null) : null
}

function buildHeader(ctx: Ctx): RunHeader {
  const { record, evals } = ctx
  const tally = deriveTally(evals)
  const usageAttempts = evals.flatMap((e) => e.attempts).filter((a) => a.usage)
  let total: number | null = null
  let cacheRead: number | null = null
  if (usageAttempts.length) {
    total = 0
    cacheRead = 0
    for (const a of usageAttempts) {
      if (!a.usage) continue
      total += totalTokens(a.usage)
      cacheRead += a.usage.cacheRead
    }
  }
  const cost = runCost(record.cost)
  const agent = record.cost?.agentUsd
  const judge = record.cost?.judgeUsd
  let basis: 'reported' | 'estimated' | 'mixed' | null = null
  if (agent || judge) {
    const bases = [agent?.basis, judge?.basis].filter(Boolean)
    basis = bases.every((b) => b === 'reported')
      ? 'reported'
      : bases.every((b) => b === 'estimated')
        ? 'estimated'
        : 'mixed'
  }
  return {
    title: runTitle(record, evals),
    status: record.status,
    startedAt: record.startedAt,
    author: record.author,
    reeval: record.stack.reeval,
    profile: record.profile?.name ?? null,
    runsPerCell: runsPerCell(evals),
    wall: durationFigure(record.durationMs),
    tally,
    tokens:
      total === null ? null : { total: tokensFigure(total), cacheRead: tokensFigure(cacheRead) },
    cost: basis
      ? {
          agent: agent ? usdFigure(agent.usd) : null,
          judge: judge ? usdFigure(judge.usd) : null,
          total: agent && judge ? usdFigure(agent.usd + judge.usd) : null,
          basis,
        }
      : cost
        ? {
            agent: null,
            judge: null,
            total: usdFigure(cost.usd),
            basis: cost.basis === 'reported' ? 'reported' : 'estimated',
          }
        : null,
    git: record.git
      ? {
          sha: record.git.sha,
          branch: record.git.branch,
          dirty: record.git.dirty,
          repo: repoBasename(record.git.remote),
        }
      : null,
  }
}

function uniqueEvalNames(evals: EvalEntry[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const e of evals) counts.set(e.name, (counts.get(e.name) ?? 0) + 1)
  const out = new Map<string, string>()
  for (const e of evals) {
    out.set(e.key, (counts.get(e.name) ?? 0) > 1 ? `${e.name} (${e.file})` : e.name)
  }
  return out
}

function shapesOf(e: EvalEntry, prior: boolean): EvalShape[] {
  const shapes: EvalShape[] = []
  if (prior) shapes.push('regression')
  if (e.compare) shapes.push('ab')
  const discovery = e.attempts.some((a) =>
    (a.assertions ?? []).some((x) =>
      /toHaveCalledSkill|toHaveFetched|toHaveCalledMcp|toHaveReadSkill/i.test(x.matcher),
    ),
  )
  if (discovery) shapes.push('discoverability')
  if (!e.compare && !prior) shapes.push('task')
  return shapes.length ? shapes : ['task']
}

function designOf(e: EvalEntry): string {
  const harnesses = new Set(e.cells.map((c) => c.harness)).size
  const arms = new Set(e.cells.map((c) => c.environment)).size
  const prompts = new Set(
    e.attempts.flatMap((a) => (a.turns[0]?.prompt ? [a.turns[0].prompt] : [])),
  ).size
  const attempts = e.attempts.filter((a) => a.seq !== null).length
  const parts: string[] = []
  if (prompts > 1) parts.push(`${prompts} prompts`)
  parts.push(`${harnesses} coding harness${harnesses === 1 ? '' : 'es'}`)
  if (arms > 1) parts.push(`${arms} arms`)
  parts.push(`${attempts} attempt${attempts === 1 ? '' : 's'}`)
  return parts.join(', ')
}

function assertionLabels(
  e: EvalEntry,
): Array<{ label: string; matcher: string; at: string | null }> {
  const seen = new Map<string, { label: string; matcher: string; at: string | null }>()
  for (const a of e.attempts) {
    for (const x of a.assertions ?? []) {
      if (seen.has(x.label)) continue
      // Skip not_applicable-only labels later via check cells.
      seen.set(x.label, { label: x.label, matcher: x.matcher, at: x.at ?? null })
    }
  }
  return [...seen.values()]
}

function checkCellOf(attempts: AttemptRecord[], label: string): CheckCell {
  let passed = 0
  let failed = 0
  let errored = 0
  let notApplicable = 0
  let preSatisfied = 0
  let notRun = 0
  let reached = 0
  let reason: string | null = null
  for (const a of attempts) {
    if (!countedOutcome(a.outcome) && a.outcome !== 'infra_error') continue
    const hit = (a.assertions ?? []).find((x) => x.label === label)
    if (!hit) {
      notRun++
      continue
    }
    reached++
    const status = hit.status as string
    if (status === 'not_applicable') {
      notApplicable++
      if (!reason && hit.reason) reason = hit.reason
      continue
    }
    if (hit.preSatisfied) preSatisfied++
    if (status === 'pass') passed++
    else if (status === 'fail') failed++
    else if (status === 'error') errored++
  }
  const answered = passed + failed
  if (reached === 0 || (answered === 0 && notApplicable > 0 && errored === 0)) {
    const na = reason ? `n/a (${reason})` : 'n/a'
    return {
      status: reached === 0 ? 'not-run' : 'na',
      passed: 0,
      answered: 0,
      notApplicable,
      preSatisfied,
      text: reached === 0 ? 'n/a' : na,
      reason: reached === 0 ? null : reason,
    }
  }
  if (errored && answered === 0) {
    return {
      status: 'error',
      passed,
      answered,
      notApplicable,
      preSatisfied,
      text: `${errored} error${errored === 1 ? '' : 's'}`,
      reason: null,
    }
  }
  const status: CheckCell['status'] =
    answered === 0 ? 'na' : failed === 0 && errored === 0 ? 'pass' : passed === 0 ? 'fail' : 'mixed'
  const base = answered === 0 ? (reason ? `n/a (${reason})` : 'n/a') : `${passed} of ${answered}`
  const text = preSatisfied > 0 ? `${base}, ${preSatisfied} pre-satisfied` : base
  return {
    status,
    passed,
    answered,
    notApplicable,
    preSatisfied,
    text,
    reason: status === 'na' ? reason : null,
  }
}

function passRateForAttempts(attempts: AttemptRecord[]): Rate {
  const counted = attempts.filter((a) => countedOutcome(a.outcome))
  const passed = counted.filter((a) => a.outcome === 'pass').length
  return rateOf(passed, counted.length)
}

function armLabel(cell: CellRecord, digestClash: boolean): string {
  if (cell.role === 'control') return cell.environment
  const name = cell.variant ?? cell.environment
  if (!digestClash || !cell.environmentDigest) return name
  return `${name} (${cell.environmentDigest.replace(/^sha256:/, '').slice(0, 7)})`
}

function armsOf(e: EvalEntry): Arm[] {
  const byEnv = new Map<string, CellRecord[]>()
  for (const c of e.cells) {
    const list = byEnv.get(c.environment) ?? []
    list.push(c)
    byEnv.set(c.environment, list)
  }
  const digestClash = [...byEnv.values()].some((cells) => {
    const digests = new Set(cells.map((c) => c.environmentDigest ?? c.environment))
    return digests.size > 1
  })
  // One arm per environment (control first), using a representative cell.
  const controls = e.cells.filter((c) => c.role === 'control')
  const variants = e.cells.filter((c) => c.role === 'variant')
  const order: CellRecord[] = []
  const seen = new Set<string>()
  for (const c of [...controls, ...variants]) {
    const key = c.environmentDigest ?? c.environment
    if (seen.has(key)) continue
    seen.add(key)
    order.push(c)
  }
  return order.map((c) => {
    const attempts = e.attempts.filter(
      (a) => cellOf(e, a.cell)?.environment === c.environment && countedOutcome(a.outcome),
    )
    const prompts = [
      ...new Set(
        attempts.flatMap((a) => {
          const p = a.turns[0]?.prompt
          return p ? [p] : []
        }),
      ),
    ]
    return {
      id: c.environmentDigest ?? c.environment,
      label: armLabel(c, digestClash),
      environment: c.environment,
      environmentDigest: c.environmentDigest,
      role: c.role === 'control' ? 'baseline' : 'variant',
      change: c.role === 'variant' ? (c.variant ?? c.environment) : null,
      prompts: prompts.map((p) => {
        // Content hash stand-in: first 12 chars of a simple digest of the prompt text length+prefix.
        let h = 0
        for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) | 0
        return `p${(h >>> 0).toString(16).padStart(8, '0')}`
      }),
    }
  })
}

function fairnessOf(nA: number, nB: number, interval: { lo: number; hi: number } | null): Fairness {
  if (Math.min(nA, nB) < COMPARE_RUNS) return 'too-few-runs'
  if (interval && containsZero(interval.lo, interval.hi)) return 'within-noise'
  return 'clear'
}

function floorSentence(fairness: Fairness, n: number): string {
  if (fairness === 'too-few-runs') {
    return `${n} per side is below ${COMPARE_RUNS}, so this cannot come back helped or made worse.`
  }
  if (fairness === 'within-noise') return 'The interval spans 0: within noise.'
  return ''
}

function headlinePrimaryText(primary: HeadlinePrimary): string {
  switch (primary.kind) {
    case 'pass-rate':
      return `${primary.rate.text} ${PASS_RATE_OUTCOME_LABEL[primary.outcome]}`
    case 'lift':
      return `${primary.variant.label} vs ${primary.baseline.label}: ${primary.points.text} pass rate (${primary.variantRate.text} vs ${primary.baselineRate.text})`
    case 'tied-ceiling':
      return `${primary.variant.label} vs ${primary.baseline.label}: tied at ${primary.rate.text} pass rate, median ${measurePhrase(primary.lead.measure)} ${primary.lead.delta.text} (${primary.lead.variant.text} vs ${primary.lead.baseline.text})`
    case 'choice':
      return `${primary.question}: ${primary.options.map((o) => `${o.label} ${o.count}`).join(', ')}`
    case 'measure':
      return `Median ${primary.label}: ${primary.spread.median.text}`
    case 'judge':
      return `${primary.label}: median ${primary.spread.median.text} on ${primary.scale[0]} to ${primary.scale[1]}`
    case 'text':
      return primary.question
    case 'regression': {
      const parts = [
        primary.worse ? `${primary.worse} worse` : null,
        primary.fixed ? `${primary.fixed} fixed` : null,
      ].filter(Boolean)
      const counts = parts.length ? parts.join(', ') : 'no gated flips'
      if (!primary.lead) return counts
      return `${counts}: ${primary.lead.signal}, ${primary.lead.prior} to ${primary.lead.current}`
    }
  }
}

function chooseHeadline(
  e: EvalEntry,
  arms: Arm[],
  prior: Ctx['prior'],
  regression: RegressionChanges | null,
): { primary: HeadlinePrimary; fairness: Fairness; foot: string; kicker: string | null } {
  const harnesses = new Set(e.cells.map((c) => c.harness)).size
  const assertions = assertionLabels(e)
  const compare = Boolean(e.compare)

  let kicker: string | null = null
  if (regression && prior) {
    const p = regression.prior
    const when = p.startedAt.slice(0, 10)
    const sha = p.gitSha ? p.gitSha.slice(0, 7) : null
    const bits = [when, sha, p.runId].filter(Boolean)
    kicker = `Compared with ${bits.join(', ')}`
  } else if (compare && arms.length >= 2) {
    const baseline = arms.find((a) => a.role === 'baseline')
    const variant = arms.find((a) => a.role === 'variant')
    if (baseline && variant) {
      kicker = `${variant.label} against the ${baseline.label} baseline`
    }
  }

  if (regression) {
    const worse = regression.rows.filter((r) => r.status === 'regressed').length
    const fixed = regression.rows.filter((r) => r.status === 'fixed').length
    const lead =
      regression.rows.find((r) => r.gate && (r.status === 'regressed' || r.status === 'fixed')) ??
      regression.rows.find((r) => r.status === 'regressed' || r.status === 'fixed') ??
      regression.rows[0] ??
      null
    const sampleNs = (prior?.rows ?? []).flatMap((row) =>
      (row.perCell ?? []).map((c) =>
        Math.min(c.base.pass + c.base.fail, c.head.pass + c.head.fail),
      ),
    )
    const minN = sampleNs.length ? Math.min(...sampleNs) : COMPARE_RUNS
    const fairness: Fairness = minN < COMPARE_RUNS ? 'too-few-runs' : 'clear'
    const footParts = [
      `${worse} worse, ${fixed} fixed since ${regression.prior.runId}.`,
      regression.prior.gitSha
        ? `Prior ${regression.prior.startedAt.slice(0, 10)} at ${regression.prior.gitSha.slice(0, 7)}.`
        : `Prior ${regression.prior.startedAt.slice(0, 10)}.`,
      fairness === 'too-few-runs' ? floorSentence('too-few-runs', minN) : null,
    ]
    return {
      primary: { kind: 'regression', worse, fixed, lead },
      fairness,
      foot: footParts.filter(Boolean).join(' '),
      kicker,
    }
  }

  if (compare && arms.length >= 2) {
    const baseline = arms.find((a) => a.role === 'baseline')!
    const variants = arms.filter((a) => a.role === 'variant')
    const attemptsFor = (arm: Arm) =>
      e.attempts.filter((a) => {
        const cell = cellOf(e, a.cell)
        return cell && (cell.environmentDigest ?? cell.environment) === arm.id
      })
    const rateFor = (arm: Arm) => passRateForAttempts(attemptsFor(arm))
    const baselineRate = rateFor(baseline)
    const lifts = variants.map((v) => {
      const rate = rateFor(v)
      const nV = rate.n
      const nB = baselineRate.n
      const { points, low, high } = liftInterval(
        { pass: rate.k, n: nV },
        { pass: baselineRate.k, n: nB },
      )
      return {
        variant: { id: v.id, label: v.label } satisfies ArmRef,
        points: ptsDelta(points),
        interval: ptsInterval(low, high),
        rate,
        rawPoints: points,
        lo: low,
        hi: high,
        n: Math.min(nV, nB),
      }
    })
    lifts.sort((a, b) => Math.abs(b.rawPoints) - Math.abs(a.rawPoints))
    const best = lifts[0]!
    const others = lifts.slice(1).map(({ variant, points, interval, rate }) => ({
      variant,
      points,
      interval,
      rate,
    }))
    const fairness = fairnessOf(best.rate.n, baselineRate.n, { lo: best.lo, hi: best.hi })
    const tied =
      REPORT_POLICY.tiedCeiling &&
      baselineRate.rate === 1 &&
      best.rate.rate === 1 &&
      assertions.length > 0

    if (tied) {
      const baseAttempts = attemptsFor(baseline).filter((a) => countedOutcome(a.outcome))
      const varAttempts = attemptsFor(variants.find((v) => v.id === best.variant.id)!).filter((a) =>
        countedOutcome(a.outcome),
      )
      const baseMeasures = measuresOf(baseAttempts)
      const varMeasures = measuresOf(varAttempts)
      let lead: {
        measure: MeasureKey
        baseline: Figure
        variant: Figure
        delta: ReturnType<typeof pctDelta>
        abs: number
      } | null = null
      for (const key of MEASURE_KEYS) {
        const b = baseMeasures[key]?.median
        const v = varMeasures[key]?.median
        if (!b || !v || b.value === null || v.value === null) continue
        const delta = pctDelta(v.value, b.value)
        if (delta.value === null) continue
        const abs = Math.abs(delta.value)
        if (abs < 0.1) continue
        if (!lead || abs > lead.abs) {
          lead = { measure: key, baseline: b, variant: v, delta, abs }
        }
      }
      if (lead) {
        const n = baselineRate.n + best.rate.n
        return {
          primary: {
            kind: 'tied-ceiling',
            baseline: { id: baseline.id, label: baseline.label },
            variant: best.variant,
            rate: baselineRate,
            assertions: assertions.length,
            lead: {
              measure: lead.measure,
              baseline: lead.baseline,
              variant: lead.variant,
              delta: lead.delta,
            },
          },
          fairness,
          foot: `Every attempt passed all ${assertions.length} applicable assertions (${n} of ${n}).`,
          kicker,
        }
      }
    }

    const floor = floorSentence(fairness, best.n)
    return {
      primary: {
        kind: 'lift',
        baseline: { id: baseline.id, label: baseline.label },
        variant: best.variant,
        points: best.points,
        interval: best.interval,
        baselineRate,
        variantRate: best.rate,
        others,
      },
      fairness,
      foot: [
        `n = ${best.rate.n} vs ${baselineRate.n} counted attempts. 95% CI ${best.interval.text}.`,
        floor,
      ]
        .filter(Boolean)
        .join(' '),
      kicker,
    }
  }

  if (assertions.length > 0) {
    const gated = e.attempts.filter((a) => {
      const cell = cellOf(e, a.cell)
      return cell && cell.gate !== 'none' && countedOutcome(a.outcome)
    })
    const pool = gated.length ? gated : e.attempts.filter((a) => countedOutcome(a.outcome))
    // An attempt "passes" the headline when every applicable assertion passed.
    let passedAll = 0
    for (const a of pool) {
      const applicable = (a.assertions ?? []).filter(
        (x) => (x.status as string) !== 'not_applicable',
      )
      if (applicable.length === 0) continue
      if (applicable.every((x) => x.status === 'pass')) passedAll++
    }
    const rate = rateOf(passedAll, pool.length)
    const outcome = passRateOutcomeFromMatchers(assertions.map((a) => a.matcher)) ?? 'passed'
    const outcomeWord = PASS_RATE_OUTCOME_LABEL[outcome]
    return {
      primary: {
        kind: 'pass-rate',
        rate,
        assertions: assertions.length,
        harnesses: Math.max(1, harnesses),
        outcome,
      },
      fairness: pool.length < COMPARE_RUNS ? 'too-few-runs' : 'clear',
      foot: `${rate.k} of ${rate.n} counted attempts ${outcomeWord} on all ${assertions.length} assertions. ${harnesses} coding harness${harnesses === 1 ? '' : 'es'}.`,
      kicker,
    }
  }

  const answers = attemptAnswerRows(e)
  const choiceRow = answers.find((r) => r.choices && r.choices.length >= 2)
  if (choiceRow?.choices) {
    const options = choiceRow.choices.map((c) => ({ label: c.choice, count: c.n }))
    const noPick = choiceRow.answers.filter((a) => !a.choice).length
    return {
      primary: {
        kind: 'choice',
        question: choiceRow.question,
        options,
        attempts: choiceRow.answers.length,
        noPick,
      },
      fairness: 'clear',
      foot: `${choiceRow.answers.length} attempts, ${noPick} without a pick.`,
      kicker,
    }
  }

  const judgeRows = e.attempts.flatMap((a) => labeledJudgments(a))
  if (judgeRows.length) {
    const first = judgeRows[0]!
    const scores = judgeRows.filter((j) => j.label === first.label).map((j) => j.judgment.score)
    const spread = spreadOf(scores, (n) => n.toFixed(2))!
    const assertion = first.check ?? null
    const threshold = assertion === null ? null : (first.judgment.threshold ?? null)
    const atOrAbove =
      threshold === null
        ? null
        : countOf(scores.filter((s) => s >= threshold).length, scores.length)
    return {
      primary: {
        kind: 'judge',
        label: first.label,
        question: first.judgment.question,
        scale: [0, 1],
        threshold,
        spread,
        atOrAbove,
      },
      fairness: scores.length < COMPARE_RUNS ? 'too-few-runs' : 'clear',
      foot: atOrAbove
        ? `${atOrAbove.text} at or above the ${threshold} threshold.`
        : 'Diagnostic judgment, no threshold.',
      kicker,
    }
  }

  const observeNumeric = e.attempts.flatMap((a) =>
    (a.observations ?? []).flatMap((o) =>
      typeof o.value === 'number' ? [{ name: o.name, value: o.value }] : [],
    ),
  )
  if (observeNumeric.length) {
    const name = observeNumeric[0]!.name
    const values = observeNumeric.filter((o) => o.name === name).map((o) => o.value)
    const spread = spreadOf(values, formatCount)!
    return {
      primary: { kind: 'measure', label: name, unit: 'count', spread },
      fairness: values.length < COMPARE_RUNS ? 'too-few-runs' : 'clear',
      foot: `${spread.n} attempts, interquartile range ${spread.q1.text} to ${spread.q3.text}.`,
      kicker,
    }
  }

  const textRow = answers.find((r) => !r.choices)
  if (textRow) {
    const answered = textRow.answers.filter((a) => a.text.trim())
    const leadAnswer = answered[0]
    let lead: Quote | null = null
    if (leadAnswer) {
      const attempt = e.attempts.find((a) => a.id === leadAnswer.attempt)
      if (attempt) {
        // Citation filled later when we have ids; placeholder href for structure.
        lead = {
          text: leadAnswer.text.slice(0, 200),
          attempt: { id: 'A?', href: '#' },
          harness: cellOf(e, attempt.cell)?.harness ?? attempt.cell,
          arm: cellOf(e, attempt.cell)?.environment ?? null,
          case: attempt.case ?? null,
          input: leadAnswer.input,
        }
      }
    }
    const leadRole =
      answered.length > 1 && lead ? 'representative' : answered.length === 1 && lead ? 'sole' : null
    return {
      primary: {
        kind: 'text',
        question: textRow.question,
        answered: countOf(answered.length, textRow.answers.length),
        lead,
        leadRole,
      },
      fairness: 'clear',
      foot:
        leadRole === 'representative'
          ? `${answered.length} of ${textRow.answers.length} attempts answered. Showing 1 representative answer.`
          : `${answered.length} of ${textRow.answers.length} attempts answered.`,
      kicker,
    }
  }

  const tokenValues = e.attempts
    .filter((a) => countedOutcome(a.outcome) && a.usage)
    .map((a) => totalTokens(a.usage!))
  const spread =
    spreadOf(tokenValues, tokensText) ??
    ({
      n: 0,
      median: tokensFigure(null),
      q1: tokensFigure(null),
      q3: tokensFigure(null),
    } satisfies Spread)
  return {
    primary: { kind: 'measure', label: 'tokens', unit: 'tokens', spread },
    fairness: tokenValues.length < COMPARE_RUNS ? 'too-few-runs' : 'clear',
    foot:
      spread.n === 0
        ? 'No attempt reported usage.'
        : `${spread.n} attempts, interquartile range ${spread.q1.text} to ${spread.q3.text}.`,
    kicker,
  }
}

function buildTaskResults(e: EvalEntry): TaskResults | null {
  const labels = assertionLabels(e)
  if (!labels.length) return null
  const harnesses = [...new Set(e.cells.map((c) => c.harness))]
  const columns = harnesses
  const assertions: AssertionRow[] = labels.map((row) => {
    const cells: Record<string, CheckCell> = {}
    for (const h of columns) {
      const attempts = e.attempts.filter((a) => cellOf(e, a.cell)?.harness === h)
      cells[h] = checkCellOf(attempts, row.label)
    }
    const total = checkCellOf(
      e.attempts.filter((a) => countedOutcome(a.outcome) || a.outcome === 'infra_error'),
      row.label,
    )
    return { label: row.label, matcher: row.matcher, at: row.at, cells, total }
  })
  const axes = ['Coding harness']
  const breakdown: BreakdownRow[] = harnesses.map((h) => {
    const attempts = e.attempts.filter((a) => cellOf(e, a.cell)?.harness === h)
    return {
      keys: [h],
      rate: passRateForAttempts(attempts),
      measures: measuresOf(attempts),
    }
  })
  const medianRow: BreakdownRow | null =
    breakdown.length > 1
      ? {
          keys: ['Median'],
          rate: passRateForAttempts(e.attempts),
          measures: measuresOf(e.attempts.filter((a) => countedOutcome(a.outcome))),
        }
      : null
  return { kind: 'task', columns, assertions, axes, breakdown, median: medianRow }
}

function buildVariantComparison(e: EvalEntry, arms: Arm[]): VariantComparison {
  const baseline = arms.find((a) => a.role === 'baseline')
  const attemptsFor = (arm: Arm) =>
    e.attempts.filter((a) => {
      const cell = cellOf(e, a.cell)
      return cell && (cell.environmentDigest ?? cell.environment) === arm.id
    })

  const baseAttempts = baseline
    ? attemptsFor(baseline).filter((a) => countedOutcome(a.outcome))
    : []
  const baseMeasures = measuresOf(baseAttempts)
  const baseRate = passRateForAttempts(baseAttempts)

  const summary: ArmRow[] = arms.map((arm) => {
    const attempts = attemptsFor(arm).filter((a) => countedOutcome(a.outcome))
    const rate = passRateForAttempts(attempts)
    const measures = measuresOf(attempts)
    const vs = emptyMeasureVsBaseline()
    for (const key of MEASURE_KEYS) {
      vs[key] = measureVs(measures[key], arm.role === 'baseline' ? null : baseMeasures[key], null)
    }
    if (arm.role === 'baseline') {
      return {
        arm: arm.label,
        rate,
        lift: null,
        interval: null,
        verdict: 'baseline' as const,
        verdictScope: 'pass-rate' as const,
        measures: vs,
      }
    }
    const { points, low, high } = liftInterval(
      { pass: rate.k, n: rate.n },
      { pass: baseRate.k, n: baseRate.n },
    )
    const fairness = fairnessOf(rate.n, baseRate.n, { lo: low, hi: high })
    const verdict =
      fairness === 'too-few-runs'
        ? 'too-few-runs'
        : fairness === 'within-noise'
          ? 'within-noise'
          : points > 0
            ? 'helped'
            : points < 0
              ? 'made-worse'
              : 'within-noise'
    return {
      arm: arm.label,
      rate,
      lift: ptsDelta(points),
      interval: ptsInterval(low, high),
      verdict,
      verdictScope: 'pass-rate' as const,
      measures: vs,
    }
  })

  const labels = assertionLabels(e)
  const columns = arms.map((a) => a.label)
  let uniform = labels.length > 0
  const assertionsByArm: AssertionRow[] = []
  for (const row of labels) {
    const cells: Record<string, CheckCell> = {}
    for (const arm of arms) {
      cells[arm.label] = checkCellOf(attemptsFor(arm), row.label)
      const cell = cells[arm.label]!
      if (cell.status !== 'pass' && cell.status !== 'na') uniform = false
    }
    const total = checkCellOf(e.attempts, row.label)
    assertionsByArm.push({
      label: row.label,
      matcher: row.matcher,
      at: row.at,
      cells,
      total,
    })
  }
  const uniformLead = uniform
    ? `Every arm passed every applicable assertion (${labels.length} checks).`
    : null

  const contrasts: ContrastRow[] = contrastsOf(e).flatMap((c) => {
    const aCell = cellOf(e, c.a)
    const bCell = cellOf(e, c.b)
    if (!aCell || !bCell || !c.lift) return []
    const fairness = fairnessOf(c.lift.variant.counted, c.lift.control.counted, c.lift.interval)
    const verdict =
      fairness === 'too-few-runs'
        ? 'too-few-runs'
        : fairness === 'within-noise'
          ? 'within-noise'
          : c.lift.points > 0
            ? 'helped'
            : c.lift.points < 0
              ? 'made-worse'
              : 'within-noise'
    return [
      {
        from: aCell.variant ?? aCell.environment,
        to: bCell.variant ?? bCell.environment,
        measure: 'pass-rate' as const,
        delta: ptsDelta(c.lift.points),
        interval: ptsInterval(c.lift.interval.lo, c.lift.interval.hi),
        verdict,
        verdictScope: 'pass-rate' as const,
      },
    ]
  })

  const harnesses = [...new Set(e.cells.map((c) => c.harness))]
  const effortByHarness = harnesses.flatMap((h) =>
    arms.map((arm) => {
      const attempts = e.attempts.filter((a) => {
        const cell = cellOf(e, a.cell)
        return (
          cell?.harness === h &&
          cell &&
          (cell.environmentDigest ?? cell.environment) === arm.id &&
          countedOutcome(a.outcome)
        )
      })
      const measures = measuresOf(attempts)
      const vs = emptyMeasureVsBaseline()
      const baseH = baseline
        ? e.attempts.filter((a) => {
            const cell = cellOf(e, a.cell)
            return (
              cell?.harness === h &&
              cell &&
              (cell.environmentDigest ?? cell.environment) === baseline.id &&
              countedOutcome(a.outcome)
            )
          })
        : []
      const baseM = measuresOf(baseH)
      for (const key of MEASURE_KEYS) {
        vs[key] = measureVs(measures[key], arm.role === 'baseline' ? null : baseM[key], null)
      }
      return {
        harness: h,
        arm: arm.label,
        rate: passRateForAttempts(attempts),
        measures: vs,
      }
    }),
  )

  return {
    kind: 'comparison',
    arms,
    uniformLead,
    summary,
    assertionsByArm: uniformLead ? [] : assertionsByArm,
    behavior: [],
    contrasts,
    effortByHarness,
  }
}

function compareSideText(row: CompareRow, side: 'base' | 'head'): string {
  const cells = row.perCell
  if (cells?.length) {
    const pass = cells.reduce((n, c) => n + c[side].pass, 0)
    const fail = cells.reduce((n, c) => n + c[side].fail, 0)
    const n = pass + fail
    if (n > 0) return `${pass} of ${n}`
  }
  return row[side] ?? 'n/a'
}

function compareSideDelta(row: CompareRow): ReturnType<typeof ptsDelta> | null {
  const cells = row.perCell
  if (!cells?.length) return null
  const basePass = cells.reduce((n, c) => n + c.base.pass, 0)
  const baseN = cells.reduce((n, c) => n + c.base.pass + c.base.fail, 0)
  const headPass = cells.reduce((n, c) => n + c.head.pass, 0)
  const headN = cells.reduce((n, c) => n + c.head.pass + c.head.fail, 0)
  if (!baseN || !headN) return null
  return ptsDelta(headPass / headN - basePass / baseN)
}

function buildRegression(prior: NonNullable<Ctx['prior']>): RegressionChanges {
  const rows: ChangeRow[] = []
  const unchanged: ChangeRow[] = []
  for (const row of prior.rows) {
    const change: ChangeRow = {
      signal: row.id,
      kind: 'outcome',
      harness: null,
      prior: compareSideText(row, 'base'),
      current: compareSideText(row, 'head'),
      delta: compareSideDelta(row),
      status: row.status,
      gate: Boolean(row.gate),
    }
    if (row.status === 'same') unchanged.push(change)
    else rows.push(change)
  }
  const whatChanged = [
    ...prior.changes.map((c) => `${c.label}: ${c.base} to ${c.head}`),
    ...prior.rows.flatMap((r) => (r.changes ?? []).map((c) => `${r.id}: ${c}`)),
  ]
  const priorRec = prior.record
  return {
    kind: 'regression',
    baseRunId: priorRec.runId,
    prior: {
      runId: priorRec.runId,
      startedAt: priorRec.startedAt,
      gitSha: priorRec.git?.sha ?? null,
      branch: priorRec.git?.branch ?? null,
      author: priorRec.author,
    },
    whatChanged,
    rows,
    unchanged,
  }
}

function buildChoices(e: EvalEntry): ChoiceBreakdown[] {
  return attemptAnswerRows(e)
    .filter((r) => r.choices && r.choices.length >= 2)
    .map((r) => {
      const options = [...(r.choices ?? [])]
        .map((c) => ({ label: c.choice, count: c.n }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      const noPick = r.answers.filter((a) => !a.choice).length
      const byKey = new Map<
        string,
        {
          arm: string | null
          prompt: string | null
          harness: string
          counts: Record<string, number>
          attempts: number
        }
      >()
      for (const ans of r.answers) {
        const attempt = e.attempts.find((a) => a.id === ans.attempt)
        if (!attempt) continue
        const cell = cellOf(e, attempt.cell)
        const harness = cell?.harness ?? attempt.cell
        const arm = cell?.environment ?? null
        const key = `${arm ?? ''}\0${harness}`
        const row = byKey.get(key) ?? {
          arm,
          prompt: null,
          harness,
          counts: Object.fromEntries(options.map((o) => [o.label, 0])),
          attempts: 0,
        }
        row.attempts++
        if (ans.choice && row.counts[ans.choice] !== undefined) row.counts[ans.choice]!++
        byKey.set(key, row)
      }
      const rows = [...byKey.values()].map((row) => ({
        ...row,
        text: options.map((o) => `${o.label} ${row.counts[o.label] ?? 0}`).join(', '),
      }))
      return {
        question: r.question,
        options,
        noPick,
        rows,
        passByPick: options.map((o) => {
          const picked = r.answers.filter((a) => a.choice === o.label)
          const passed = picked.filter((a) => a.outcome === 'pass').length
          return { option: o.label, rate: rateOf(passed, picked.length) }
        }),
      }
    })
}

function buildDiscovery(e: EvalEntry): DiscoveryRate[] {
  if (e.compare) return []
  const matchers = [
    { what: 'skill', matcher: 'toHaveCalledSkill' },
    { what: 'MCP tool', matcher: 'toHaveCalledMcp' },
    { what: 'web fetch', matcher: 'toHaveFetched' },
  ]
  const out: DiscoveryRate[] = []
  for (const m of matchers) {
    const attempts = e.attempts.filter((a) => countedOutcome(a.outcome))
    const foundAttempts = attempts.filter((a) =>
      (a.assertions ?? []).some((x) => x.matcher.includes(m.matcher) && x.status === 'pass'),
    )
    if (
      !foundAttempts.length &&
      !attempts.some((a) => (a.assertions ?? []).some((x) => x.matcher.includes(m.matcher)))
    ) {
      continue
    }
    const applicable = attempts.filter((a) =>
      (a.assertions ?? []).some((x) => x.matcher.includes(m.matcher)),
    )
    if (!applicable.length) continue
    out.push({
      what: m.what,
      matcher: m.matcher,
      found: countOf(foundAttempts.length, applicable.length),
      rows: [...new Set(e.cells.map((c) => c.harness))].map((h) => {
        const pool = applicable.filter((a) => cellOf(e, a.cell)?.harness === h)
        const found = pool.filter((a) =>
          (a.assertions ?? []).some((x) => x.matcher.includes(m.matcher) && x.status === 'pass'),
        )
        return { keys: [h], found: countOf(found.length, pool.length) }
      }),
      sources: [],
    })
  }
  return out
}

function buildJudgments(e: EvalEntry): JudgmentBreakdown | null {
  const scores = e.attempts.flatMap((a) => {
    const cell = cellOf(e, a.cell)
    return labeledJudgments(a).map((j) => ({
      ...j,
      keys: [cell?.harness ?? a.cell, cell?.environment ?? ''].filter(Boolean),
    }))
  })
  if (!scores.length && !(e.answers ?? []).length) return null
  const byLabel = new Map<string, typeof scores>()
  for (const s of scores) {
    const list = byLabel.get(s.label) ?? []
    list.push(s)
    byLabel.set(s.label, list)
  }
  const hasArms = e.cells.some((c) => Boolean(c.environment))
  const judgeRows = [...byLabel.entries()].map(([label, rows]) => {
    const values = rows.map((r) => r.judgment.score)
    const spread = spreadOf(values, (n) => n.toFixed(2))!
    const assertion = rows[0]!.check ?? null
    // No `toPass` assertion: diagnostic. Omit threshold tally even if the call scored one.
    const threshold = assertion === null ? null : (rows[0]!.judgment.threshold ?? null)
    return {
      label,
      question: rows[0]!.judgment.question,
      assertion,
      threshold,
      keys: hasArms ? ['Coding harness', 'Arm'] : ['Coding harness'],
      spread,
      atOrAbove:
        threshold === null
          ? null
          : countOf(values.filter((v) => v >= threshold).length, values.length),
    }
  })
  // Pairwise from eval.answers: rates only; attempt cites need PairVote.attempts (newer records).
  const pairwise: JudgmentBreakdown['pairwise'] = []
  for (const ans of e.answers ?? []) {
    const ties = ans.votes.filter((v) => v.winner === 'tie').length
    for (const cut of ['within', 'across'] as const) {
      const rates = ans.rates.filter((r) => r.cut === cut)
      if (rates.length < 2) {
        for (const r of rates) {
          pairwise.push({
            question: ans.question,
            cut,
            a: r.name,
            b: 'rest',
            aWins: r.wins,
            bWins: Math.max(0, r.n - r.wins),
            ties,
            pairs: r.n,
            reasons: [],
          })
        }
        continue
      }
      const [a, b] = rates
      if (!a || !b) continue
      pairwise.push({
        question: ans.question,
        cut,
        a: a.name,
        b: b.name,
        aWins: a.wins,
        bWins: b.wins,
        ties,
        pairs: Math.max(a.n, b.n),
        reasons: [],
      })
    }
  }
  return {
    axes: hasArms ? ['Coding harness', 'Arm'] : ['Coding harness'],
    scores: judgeRows,
    pairwise,
  }
}

function buildQualitative(
  e: EvalEntry,
  ids: AttemptIdMap,
  linkBase: string | undefined,
  hrefs: Set<string>,
  hrefByKey: Map<string, string>,
): QualitativeAnswers[] {
  return attemptAnswerRows(e)
    .filter((r) => !r.choices)
    .map((r) => {
      const entries: Quote[] = []
      for (const ans of r.answers) {
        if (!ans.text.trim()) continue
        const attempt = e.attempts.find((a) => a.id === ans.attempt)
        if (!attempt) continue
        const ref = attemptRef(ids, e, attempt, linkBase, hrefs, hrefByKey)
        if (!ref) continue
        const cell = cellOf(e, attempt.cell)
        entries.push({
          text: ans.text.slice(0, 400),
          attempt: ref,
          harness: cell?.harness ?? attempt.cell,
          arm: cell?.environment ?? null,
          case: attempt.case ? caseName(e, { key: attempt.case, name: undefined }) : null,
          input: ans.input ? withBase(linkBase, ans.input) : null,
        })
      }
      return {
        question: r.question,
        answered: countOf(entries.length, r.answers.length),
        themes: null,
        entries,
      }
    })
}

function buildCaptures(
  e: EvalEntry,
  ids: AttemptIdMap,
  linkBase: string | undefined,
  hrefs: Set<string>,
  hrefByKey: Map<string, string>,
  pages?: ReadonlyMap<string, CapturePageFile>,
): CaptureGallery | null {
  const rows = new Map<
    string,
    {
      harness: string
      arm: string | null
      case: string | null
      shots: CaptureGallery['rows'][number]['shots']
    }
  >()
  for (const a of e.attempts) {
    const arts = a.files.artifacts ?? []
    if (!arts.length) continue
    const ref = attemptRef(ids, e, a, linkBase, hrefs, hrefByKey)
    if (!ref) continue
    const cell = cellOf(e, a.cell)
    const key = `${cell?.harness ?? ''}\0${cell?.environment ?? ''}\0${a.case ?? ''}`
    const row = rows.get(key) ?? {
      harness: cell?.harness ?? a.cell,
      arm: cell?.environment ?? null,
      case: a.case ?? null,
      shots: [],
    }
    for (const art of arts) {
      const pagePath = art.capture?.page?.path
      const page = pagePath ? pages?.get(pagePath) : undefined
      row.shots.push({
        name: art.name,
        href: captureHref(art.path, linkBase),
        meta:
          page?.finalUrl ??
          (art.capture?.instructions?.length
            ? art.capture.instructions.join('; ')
            : (art.capture?.path ?? null)),
        attempt: ref,
        status: art.capture?.status ?? page?.status ?? null,
        pageErrors: art.capture?.pageErrors ?? page?.errors.length ?? null,
        consoleErrors:
          (art.capture as { consoleErrors?: number } | undefined)?.consoleErrors ??
          page?.console.filter((c) => c.level === 'error').length ??
          null,
      })
    }
    rows.set(key, row)
  }
  if (!rows.size) return null
  return { rows: [...rows.values()] }
}

function buildFailures(
  e: EvalEntry,
  ids: AttemptIdMap,
  linkBase: string | undefined,
  hrefs: Set<string>,
  hrefByKey: Map<string, string>,
  remarks: RunRemarks | null,
): FailureClusters | null {
  const counted = e.attempts.filter((a) => countedOutcome(a.outcome) || a.outcome === 'infra_error')
  const clusters = new Map<string, FailureClusters['clusters'][number]>()
  const add = (
    kind: FailureClusters['clusters'][number]['kind'],
    label: string,
    at: string | null,
    attempt: AttemptRecord,
  ) => {
    const ref = attemptRef(ids, e, attempt, linkBase, hrefs, hrefByKey)
    if (!ref) return
    const key = `${kind}\0${label}\0${at ?? ''}`
    const existing = clusters.get(key)
    if (existing) {
      existing.attempts.push(ref)
      existing.count = countOf(existing.attempts.length, counted.length)
      return
    }
    clusters.set(key, {
      kind,
      label,
      at,
      count: countOf(1, counted.length),
      attempts: [ref],
    })
  }
  for (const a of e.attempts) {
    for (const x of a.assertions ?? []) {
      if (x.status === 'fail') add('assertion', x.label, x.at ?? null, a)
    }
    for (const t of a.turns) {
      if (t.status === 'error' && t.error) {
        add('turn-error', messageLine(t.error), null, a)
      }
    }
    if (a.outcome === 'infra_error' && a.error) {
      add('infra-error', messageLine(a.error.message), null, a)
    } else if (a.error && a.outcome === 'fail') {
      add('error', messageLine(a.error.message), null, a)
    }
  }
  // Remark.evalId is the suite fact path (`factSegment(id)`); evalKey is EvalEntry.key when set.
  // Summary keeps concerns only (CLI `Remarks:` without `-v`); suggestions stay out of Worth knowing.
  const evalPath = factSegment(e.id)
  const evalRemarks =
    remarks?.remarks
      .filter(
        (r) =>
          r.severity === 'concern' &&
          (r.evalKey === e.key || r.evalId === e.id || r.evalId === e.key || r.evalId === evalPath),
      )
      .map((r) => ({ kind: r.kind, severity: r.severity, text: r.text, fix: r.fix })) ?? []
  if (!clusters.size && !evalRemarks.length) return null
  return {
    clusters: [...clusters.values()].sort((a, b) => b.count.k - a.count.k),
    remarks: evalRemarks,
  }
}

function fillTextLeadCites(
  primary: HeadlinePrimary,
  e: EvalEntry,
  ids: AttemptIdMap,
  linkBase: string | undefined,
  hrefs: Set<string>,
  hrefByKey: Map<string, string>,
): HeadlinePrimary {
  if (primary.kind !== 'text' || !primary.lead) return primary
  const answers = attemptAnswerRows(e).find((r) => r.question === primary.question)
  const first = answers?.answers.find((a) => a.text.trim())
  if (!first) return primary
  const attempt = e.attempts.find((a) => a.id === first.attempt)
  if (!attempt) return primary
  const ref = attemptRef(ids, e, attempt, linkBase, hrefs, hrefByKey)
  if (!ref) return primary
  return { ...primary, lead: { ...primary.lead, attempt: ref } }
}

function buildEvalSection(ctx: Ctx, e: EvalEntry, displayName: string): EvalSection {
  const arms = armsOf(e)
  const shapes = shapesOf(e, Boolean(ctx.prior))
  const design = designOf(e)
  const regression = ctx.prior ? buildRegression(ctx.prior) : null
  const chosen = chooseHeadline(e, arms, ctx.prior, regression)
  const primaryHeadline = fillTextLeadCites(
    chosen.primary,
    e,
    ctx.ids,
    ctx.linkBase,
    ctx.hrefs,
    ctx.hrefByKey,
  )
  const headline: EvalHeadline = {
    task: displayName,
    kicker: chosen.kicker,
    fairness: chosen.fairness,
    primary: primaryHeadline,
    foot: chosen.foot,
  }
  let primary: EvalSection['primary'] = null
  if (regression) primary = regression
  else if (e.compare) primary = buildVariantComparison(e, arms)
  else primary = buildTaskResults(e)

  const insights: ReportClaim[] = []
  if (ctx.analysis) {
    const body = ctx.analysis.analysis
    for (const claim of [...body.whatHappened, ...body.results, ...body.why]) {
      insights.push({
        role: 'finding',
        text: claim.text,
        confidence: claim.confidence,
        cites: [],
        action: null,
      })
    }
    for (const anomaly of body.anomalies) {
      insights.push({
        role: 'caveat',
        text: anomaly.text,
        confidence: 'medium',
        cites: [],
        action: null,
      })
    }
  }

  return {
    id: e.key,
    anchor: gfmAnchor(displayName),
    name: displayName,
    file: e.file,
    shapes,
    design,
    headline,
    insights,
    primary,
    choices: buildChoices(e),
    discovery: buildDiscovery(e),
    judgments: buildJudgments(e),
    qualitative: buildQualitative(e, ctx.ids, ctx.linkBase, ctx.hrefs, ctx.hrefByKey),
    captures: buildCaptures(e, ctx.ids, ctx.linkBase, ctx.hrefs, ctx.hrefByKey, ctx.pages),
    failures: buildFailures(e, ctx.ids, ctx.linkBase, ctx.hrefs, ctx.hrefByKey, ctx.remarks),
  }
}

function buildIntegrity(ctx: Ctx): IntegrityIssue[] {
  const issues: IntegrityIssue[] = []
  const { record, evals, ids, linkBase } = ctx
  if (record.status !== 'complete') {
    issues.push({
      kind: 'run-incomplete',
      severity: 'error',
      text: `Run stopped early (${record.status}); pass rates and medians cover only the attempts that finished.`,
      evalId: null,
      cites: [],
    })
  }
  if (record.git?.dirty) {
    issues.push({
      kind: 'dirty-worktree',
      severity: 'warn',
      text: 'The worktree was dirty; an exact rerun needs the saved worktree patch.',
      evalId: null,
      cites: [],
    })
  }
  for (const e of evals) {
    const cites: AttemptRef[] = []
    for (const a of e.attempts) {
      const turnErr = a.turns.some((t) => t.status === 'error')
      if (!turnErr) continue
      const ref = attemptRef(ids, e, a, linkBase, ctx.hrefs, ctx.hrefByKey)
      if (ref) cites.push(ref)
    }
    if (cites.length) {
      issues.push({
        kind: 'turn-error',
        severity: 'error',
        text: `${cites.length} attempt${cites.length === 1 ? '' : 's'} had a mid-turn error; those outcomes may not reflect a finished agent turn.`,
        evalId: e.key,
        cites,
      })
    }
    const envNames = new Map<string, Set<string>>()
    for (const c of e.cells) {
      const set = envNames.get(c.environment) ?? new Set()
      set.add(c.environmentDigest ?? c.environment)
      envNames.set(c.environment, set)
    }
    for (const [name, digests] of envNames) {
      if (digests.size > 1) {
        issues.push({
          kind: 'duplicate-environment',
          severity: 'warn',
          text: `Environment name "${name}" maps to ${digests.size} digests; arm labels include the digest prefix.`,
          evalId: e.key,
          cites: [],
        })
      }
    }
    if (e.compare) {
      for (const c of e.cells.filter((x) => x.role === 'control')) {
        for (const check of c.checks ?? []) {
          const answered = check.pass + check.fail
          if (answered > 0 && check.pass === 0) {
            const variant = e.cells.find(
              (v) =>
                v.role === 'variant' &&
                v.harness === c.harness &&
                v.sandbox === c.sandbox &&
                (v.checks ?? []).some(
                  (k) => k.label === check.label && k.pass === k.pass + k.fail && k.pass > 0,
                ),
            )
            if (variant) {
              issues.push({
                kind: 'baseline-never-passes',
                severity: 'warn',
                text: `Check "${check.label}" never passes on the baseline and always passes on a variant; it may not apply to the baseline.`,
                evalId: e.key,
                cites: [],
              })
            }
          }
        }
      }
    }
    for (const a of e.attempts) {
      if (!a.usage && countedOutcome(a.outcome)) {
        // Collect once per eval below.
      }
    }
    const unreported = e.attempts.filter((a) => countedOutcome(a.outcome) && !a.usage)
    if (unreported.length) {
      issues.push({
        kind: 'unreported-usage',
        severity: 'warn',
        text: `${unreported.length} counted attempt${unreported.length === 1 ? '' : 's'} reported no token usage; token medians omit them.`,
        evalId: e.key,
        cites: unreported.flatMap((a) => {
          const ref = attemptRef(ids, e, a, linkBase, ctx.hrefs, ctx.hrefByKey)
          return ref ? [ref] : []
        }),
      })
    }
    const preHits = e.attempts.flatMap((a) =>
      (a.assertions ?? [])
        .filter((x) => x.preSatisfied)
        .map((x) => ({ attempt: a, label: x.label })),
    )
    if (preHits.length) {
      const labels = [...new Set(preHits.map((h) => h.label))]
      issues.push({
        kind: 'pre-satisfied',
        severity: 'warn',
        text: `${preHits.length} pre-satisfied check${preHits.length === 1 ? '' : 's'} (${labels.join(', ')}); existing workspace state may satisfy them without agent work.`,
        evalId: e.key,
        cites: preHits.flatMap((h) => {
          const ref = attemptRef(ids, e, h.attempt, linkBase, ctx.hrefs, ctx.hrefByKey)
          return ref ? [ref] : []
        }),
      })
    }
  }
  if (ctx.prior) {
    const sampleNs = ctx.prior.rows.flatMap((row) =>
      (row.perCell ?? []).map((c) =>
        Math.min(c.base.pass + c.base.fail, c.head.pass + c.head.fail),
      ),
    )
    const gatedTiny = ctx.prior.rows.some(
      (row) =>
        (row.status === 'regressed' || row.status === 'fixed') &&
        Boolean(row.gate) &&
        (row.perCell ?? []).some(
          (c) => Math.min(c.base.pass + c.base.fail, c.head.pass + c.head.fail) < COMPARE_RUNS,
        ),
    )
    if (gatedTiny || (sampleNs.length && Math.min(...sampleNs) < COMPARE_RUNS)) {
      const minN = sampleNs.length ? Math.min(...sampleNs) : 0
      issues.push({
        kind: 'fairness-floor',
        severity: 'warn',
        text: `A gated regression claim rests on fewer than ${COMPARE_RUNS} counted attempts per side${minN ? ` (as low as ${minN})` : ''}; treat worse/fixed as provisional.`,
        evalId: null,
        cites: [],
      })
    }
  }
  return issues
}

function buildRoster(evals: EvalEntry[], record: RunRecord): RosterRow[] {
  if (evals.length < 2) return []
  const harnesses = record.stack.harnesses
  if (harnesses.length < 2) return []
  return harnesses.map((h) => {
    const attempts = evals.flatMap((e) =>
      e.attempts.filter((a) => cellOf(e, a.cell)?.harness === h.id && a.seq !== null),
    )
    const gateways = [
      ...new Set(
        evals.flatMap((e) =>
          e.cells
            .filter((c) => c.harness === h.id)
            .map((c) => c.gateway)
            .filter(Boolean),
        ),
      ),
    ] as string[]
    return {
      harness: h.id,
      model: h.model ?? null,
      effort: h.effort ?? null,
      servedModels: h.resolvedModels ?? [],
      gateway: gateways[0] ?? null,
      attempts: attempts.length,
    }
  })
}

function buildRollup(
  sections: EvalSection[],
  analysis: AnalysisDoc | null,
): ExecutiveRollup | null {
  if (sections.length < 2 && !analysis?.analysis.tldr) return null
  const lead: ReportClaim | null = analysis?.analysis.tldr
    ? {
        role: 'finding',
        text: analysis.analysis.tldr,
        confidence: analysis.analysis.confidence.overall,
        cites: [],
        action: null,
      }
    : null
  const findings: ReportClaim[] = analysis
    ? [...analysis.analysis.whatHappened, ...analysis.analysis.results].map((c) => ({
        role: 'finding' as const,
        text: c.text,
        confidence: c.confidence,
        cites: [],
        action: null,
      }))
    : []
  return {
    lead,
    rows: sections.map((s) => ({
      evalId: s.id,
      name: s.name,
      anchor: s.anchor,
      shapes: s.shapes,
      design: s.design,
      primary: headlinePrimaryText(s.headline.primary),
      medianTokens:
        s.headline.primary.kind === 'measure' && s.headline.primary.unit === 'tokens'
          ? s.headline.primary.spread.median
          : tokensFigure(
              s.primary && 'breakdown' in s.primary
                ? (s.primary.median?.measures.tokens?.median.value ??
                    s.primary.breakdown[0]?.measures.tokens?.median.value ??
                    null)
                : null,
            ),
    })),
    findings,
  }
}

function buildActions(analysis: AnalysisDoc | null): ReportClaim[] {
  if (!analysis) return []
  return analysis.analysis.actions.map((a) => ({
    role: 'action' as const,
    text: a.title,
    confidence: analysis.analysis.confidence.overall,
    cites: [],
    action: {
      kind: a.kind,
      target: a.target,
      change: a.change,
      verify: a.verify,
    },
  }))
}

function buildAttemptIndex(ctx: Ctx): AttemptIndexRow[] {
  const { evals, ids, linkBase, record, hrefByKey } = ctx
  const rows: AttemptIndexRow[] = []
  for (const e of evals) {
    for (const a of e.attempts) {
      if (a.seq === null) continue
      const id = ids.get(a.key)
      if (!id) continue
      const cell = cellOf(e, a.cell)
      const href = hrefByKey.get(a.key) ?? attemptHref(e, a, id, linkBase, ctx.hrefs)
      const diffStats = attemptDiffStats(a)
      const reclassified =
        a.outcome === 'infra_error' &&
        ((a as { turnStatusRead?: boolean }).turnStatusRead === false ||
          ((a as { turnStatusRead?: boolean }).turnStatusRead === undefined &&
            a.turns.some((t) => t.status === 'error')))
      const canceled =
        a.outcome === 'fail' && a.error?.kind === 'aborted' && record.status === 'interrupted'
      rows.push({
        id,
        key: a.key,
        evalId: e.key,
        harness: cell?.harness ?? a.cell,
        arm: cell?.environment ?? null,
        case: a.case ?? null,
        outcome: canceled ? 'canceled' : (a.outcome as AttemptIndexRow['outcome']),
        reclassified,
        turnError: turnErrorMessage(a),
        tokens: tokensFigure(a.usage ? totalTokens(a.usage) : null),
        agentMs: durationFigure(a.timings.agentMs),
        toolCalls: countFigure(a.activity.tools),
        diff:
          diffStats.files === 0 && diffStats.added === null
            ? null
            : {
                files: diffStats.files,
                added: diffStats.added,
                removed: diffStats.removed,
                text:
                  diffStats.added === null || diffStats.removed === null
                    ? `${diffStats.files} files (lines not recorded)`
                    : `${diffStats.files} files, ${diffLinesText(diffStats.added, diffStats.removed)}`,
              },
        links: {
          transcript: a.files.transcript ? withBase(linkBase, a.files.transcript.path) : null,
          diff: a.files.diff ? withBase(linkBase, a.files.diff.path) : null,
          captures: (a.files.artifacts ?? []).map((art) => ({
            name: art.name,
            href: withBase(linkBase, art.path),
          })),
          questions: (a.answers ?? [])
            .map((q) => q.input?.path)
            .filter((p): p is string => Boolean(p))
            .map((p) => withBase(linkBase, p)),
        },
        href,
      })
    }
  }
  return rows.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
}

/** The only reader of a `RunRecord` for a report. Pure and deterministic. */
export function buildRunReport(record: RunRecord, options: RunReportOptions = {}): RunReport {
  const evals = selectedEvals(record, options.evals)
  if (evals.length === 0) {
    throw new Error('buildRunReport: no evals selected')
  }
  const names = uniqueEvalNames(evals)
  const ids = attemptIds(record, new Set(evals.map((e) => e.key)))
  const ctx: Ctx = {
    record,
    evals,
    ids,
    linkBase: options.links?.base,
    remarks: options.remarks ?? null,
    analysis: options.analysis ?? null,
    pages: options.pages,
    prior: options.prior ?? null,
    hrefs: new Set(),
    hrefByKey: new Map(),
  }
  assignAttemptHrefs(ctx)
  const header = buildHeader(ctx)
  if (options.title) header.title = options.title
  else header.title = runTitle(record, evals)

  const sections = evals.map((e) => buildEvalSection(ctx, e, names.get(e.key) ?? e.name))
  const single = sections.length === 1
  const rollup = buildRollup(sections, ctx.analysis)
  const roster = buildRoster(evals, record)

  return {
    reportVersion: 1,
    runId: record.runId,
    single,
    header,
    integrity: buildIntegrity(ctx),
    rollup: single && !ctx.analysis?.analysis.tldr ? null : rollup,
    roster,
    evals: sections,
    actions: buildActions(ctx.analysis),
    provenance: provenanceState(record, options.links?.record),
    attempts: buildAttemptIndex(ctx),
  }
}
