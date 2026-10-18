// The run's plan: what it will start, how long that should take, and whether it fits the budget.
import { acrossOf, type PairAttempt, pairsOf, plannedSides } from './compare/pairs.ts'
import { questionShows, resolveQuestionState } from './compare/state.ts'
import type { ExcludedEval, PlannedItem } from './engine/node.ts'
import { UsageError } from './errors.ts'
import { recentRecords, scratchDir } from './history/files.ts'
import { clip, formatDuration } from './text.ts'
import type {
  Budget,
  Cell,
  CellGate,
  Duration,
  EvalPlan,
  FamilyMeta,
  HarnessDescriptor,
  PairFactor,
  PlannedEgress,
  PlannedQuestion,
  ResolvedProfile,
  SandboxDescriptor,
  SandboxWarning,
} from './types.ts'
import { EFFORT_ALPHA, EFFORT_MIN_RUNS } from './view/effort.ts'

/** With no history for a harness, an attempt is assumed to take this long (the fake agent: 1s). */
const DEFAULT_ATTEMPT_MS = 3 * 60_000
const DEFAULT_FAKE_MS = 1000
/** The most recent runs whose durations feed the estimate. */
const HISTORY_RUNS = 30

export type PlanRow = {
  id: string
  plan: EvalPlan
  /** Set on each case of a pooled `evaluate.each`. */
  family?: FamilyMeta
  /** Optimistic pair sides for `--dry-run`: every planned attempt is assumed to pass checks. */
  sides: PairAttempt[]
}

export type RunPlan = {
  profile: ResolvedProfile | null
  rows: PlanRow[]
  evals: number
  cells: number
  attempts: number
  /** Serial: every attempt one after another. */
  estimateMs: number
  concurrency: number
  budget: Budget
  warnings: string[]
  /** One per level whose sandbox runs as root or with capabilities added back. */
  sandboxWarnings: SandboxWarning[]
  /** Advice that doesn't stop the run, e.g. about the default gate. */
  hints: string[]
  sandboxes: SandboxDescriptor[]
  /** The harnesses the planned attempts run on, for their credentials. */
  harnessDescriptors: HarnessDescriptor[]
  /** The harness ids the planned attempts run on, for the run header. */
  harnesses: string[]
  /** The model that answers a compare question naming none; null when there's no language model. */
  questionModel: string | null
  /** The run this plan belongs to, minted or resumed before collect. */
  runId?: string
  /** Set when this plan continues a stopped, interrupted or budget-stopped run. */
  resume?: { runId: string; completed: number }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** Attempt durations from the latest recorded and scratch runs, by eval and harness. */
export async function historyDurations(root: string, historyDir: string) {
  const records = await recentRecords([historyDir, scratchDir(root)], HISTORY_RUNS)
  const byEval = new Map<string, number[]>()
  const byHarness = new Map<string, number[]>()
  const push = (map: Map<string, number[]>, key: string, ms: number) =>
    map.set(key, [...(map.get(key) ?? []), ms])
  for (const record of records) {
    for (const e of record.evals ?? []) {
      for (const a of e.attempts ?? []) {
        if (a.outcome !== 'pass' && a.outcome !== 'fail') continue
        const harness = e.cells?.find((c) => c.key === a.cell)?.harness
        if (!harness) continue
        push(byEval, `${e.id}\0${harness}`, a.durationMs)
        push(byHarness, harness, a.durationMs)
      }
    }
  }
  return (id: string, harness: string, kind: string) => {
    const own = byEval.get(`${id}\0${harness}`)
    if (own?.length) return median(own)
    const any = byHarness.get(harness)
    if (any?.length) return median(any)
    return kind === 'fake' ? DEFAULT_FAKE_MS : DEFAULT_ATTEMPT_MS
  }
}

export async function buildPlan(options: {
  planned: PlannedItem[]
  profile: ResolvedProfile | null
  budget: Budget
  concurrency: number
  root: string
  historyDir: string
  questionModel?: string | null
}): Promise<RunPlan> {
  const { planned } = options
  const estimate = await historyDurations(options.root, options.historyDir)
  const rows = new Map<string, PlanRow>()
  const cells = new Set<string>()
  const warnings = new Set<string>()
  const sandboxWarnings = new Map<string, SandboxWarning>()
  const sandboxes = new Map<string, SandboxDescriptor>()
  const descriptors = new Map<string, HarnessDescriptor>()
  const harnesses = new Set<string>()
  // A filter can leave out some of an eval's cells: each row counts what it actually plans.
  const counted = new Map<
    string,
    { harnesses: Set<string>; variants: Set<string>; n: number; gated: boolean }
  >()
  let attempts = 0
  let estimateMs = 0
  for (const { id, attempt } of planned) {
    const existing = rows.get(id)
    if (!existing || existing.plan.skip) {
      rows.set(id, {
        id,
        plan: attempt.plan,
        sides: [],
        ...(attempt.family ? { family: attempt.family } : {}),
      })
    }
    for (const w of attempt.plan.warnings) warnings.add(w)
    if (attempt.skip || attempt.plan.skip) continue
    for (const w of attempt.plan.sandboxWarnings) {
      sandboxWarnings.set(`${w.file}\0${w.message}`, w)
    }
    attempts++
    cells.add(`${id}\0${attempt.cell.key}`)
    estimateMs += estimate(id, attempt.cell.harness, attempt.harness.kind)
    sandboxes.set(JSON.stringify(attempt.sandbox), attempt.sandbox)
    descriptors.set(JSON.stringify(attempt.harness), attempt.harness)
    harnesses.add(attempt.cell.harness)
    const row = counted.get(id) ?? {
      harnesses: new Set(),
      variants: new Set(),
      n: 0,
      gated: false,
    }
    row.harnesses.add(attempt.cell.harness)
    if (attempt.gate !== 'none') row.gated = true
    if (attempt.cell.variant !== undefined) row.variants.add(attempt.cell.variant)
    row.n++
    counted.set(id, row)
  }
  for (const row of rows.values()) {
    const c = counted.get(row.id)
    if (!c) continue
    const { variants } = row.plan
    row.plan = {
      ...row.plan,
      harnesses: c.harnesses.size,
      variants: variants && { run: c.variants.size, of: variants.of },
      attempts: c.n,
    }
    row.sides = plannedSides(
      planned
        .filter((p) => p.id === row.id && !p.attempt.skip && !p.attempt.plan.skip)
        .map((p) => p.attempt),
    )
  }
  return {
    profile: options.profile,
    rows: [...rows.values()],
    evals: [...rows.values()].filter((r) => !r.plan.skip).length,
    cells: cells.size,
    attempts,
    estimateMs,
    concurrency: options.concurrency,
    budget: options.budget,
    warnings: [...warnings],
    sandboxWarnings: [...sandboxWarnings.values()].sort(
      (a, b) => Number(a.kind !== 'root') - Number(b.kind !== 'root'),
    ),
    hints: [
      ...gateHint([...rows.values()].filter((r) => counted.get(r.id)?.gated)),
      ...effortHint([...rows.values()]),
    ],
    sandboxes: [...sandboxes.values()],
    harnessDescriptors: [...descriptors.values()],
    harnesses: [...harnesses],
    questionModel: options.questionModel ?? null,
  }
}

export type PlanQuestion = {
  question: string
  /** Its own model, else the plan's question model; null when there's no language model. */
  model: string | null
  /** The factor it varies; unset when both pair kinds run (the default). */
  across?: PairFactor
  /** Pairs it will ask, assuming every attempt passes its checks. */
  pairs: number
  /** The parts each side shows: its `state` keys that are on, then `artifacts` when it sends captures. */
  shows: string[]
}

/** `environment · 2 pairs` when it varies one factor; `4 pairs` when it asks both. */
export const questionPairLabel = (q: Pick<PlanQuestion, 'across' | 'pairs'>): string => {
  const n = `${q.pairs} ${q.pairs === 1 ? 'pair' : 'pairs'}`
  return q.across ? `${q.across} · ${n}` : n
}

/** An eval's compare questions, each with the model that will answer it and its pair count. */
export const planQuestions = (
  questions: PlannedQuestion[] | undefined,
  sides: PairAttempt[],
  questionModel: string | null,
  skip?: string,
): PlanQuestion[] =>
  (skip ? [] : (questions ?? [])).map((q) => ({
    question: q.question,
    model: q.model ?? questionModel,
    ...(q.across ? { across: q.across } : {}),
    pairs: pairsOf(sides, acrossOf(q.across)).length,
    shows: questionShows(resolveQuestionState(q.state), q.artifacts),
  }))

/** `  question 1/2  Which is cleaner? · after the run · 4 pairs · google/gemini-3.8-flash` */
function questionLines(members: PlanRow[], questionModel: string | null): string[] {
  const [first] = members
  if (!first) return []
  const asked = members.map((row) =>
    planQuestions(row.plan.questions, row.sides, questionModel, row.plan.skip),
  )
  const questions = (asked[0] ?? []).map((q, i) => ({
    ...q,
    pairs: asked.reduce((sum, list) => sum + (list[i]?.pairs ?? 0), 0),
  }))
  return questions.map(
    (q, i) =>
      `  question ${i + 1}/${questions.length}  ${clip(q.question, 80)} · after the run · shows ${q.shows.join(', ')} · ${questionPairLabel(q)} · ${q.model ?? 'needs a language model: set analysis.model'}`,
  )
}

/** One line when evals run several times under the default gate, which every attempt must pass. */
/** Rows with a gated cell left at the default gate; a study whose cells are all `'none'` has none. */
function gateHint(rows: PlanRow[]): string[] {
  const n = rows.filter((r) => !r.plan.skip && r.plan.runs > 1 && r.plan.gate === undefined).length
  if (n === 0) return []
  return [
    `${plural(n, 'eval')} ${n === 1 ? 'runs' : 'run'} more than once with the default gate, so every attempt must pass (pass^k); set gate: { passRate: 0.8 } to gate on pass@1 instead`,
  ]
}

/** One line when compares run too few times per cell for effort's test to ever reach p < 0.05. */
function effortHint(rows: PlanRow[]): string[] {
  const few = rows.filter(
    (r) =>
      !r.plan.skip &&
      (r.plan.variants?.run ?? 0) > 0 &&
      r.plan.runs >= 2 &&
      r.plan.runs < EFFORT_MIN_RUNS,
  )
  if (few.length === 0) return []
  const runs = [...new Set(few.map((r) => r.plan.runs))].sort((a, b) => a - b).join(' or ')
  return [
    `${plural(few.length, 'compare')} ${few.length === 1 ? 'runs' : 'run'} ${runs} times per cell; effort can't reach p < ${EFFORT_ALPHA} below ${EFFORT_MIN_RUNS} vs ${EFFORT_MIN_RUNS} (runs: ${EFFORT_MIN_RUNS})`,
  ]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * `plan  profile pr (auto: CI is set) · 3 evals · 4 cells · 12 attempts · ~9m serial · …`, led by
 * `config ../reeval.config.ts` when `config` is given (the config isn't in the current directory).
 */
export function planLine(plan: RunPlan, config?: string, runId?: string): string {
  const parts: string[] = []
  const id = runId ?? plan.runId
  if (id) parts.push(`run ${id}`)
  if (config) parts.push(`config ${config}`)
  if (plan.resume) parts.push('resume')
  if (plan.profile) parts.push(`profile ${plan.profile.name} (${plan.profile.reason})`)
  const skipped = plan.rows.length - plan.evals
  parts.push(plural(plan.evals, 'eval') + (skipped ? ` (${skipped} skipped)` : ''))
  parts.push(plural(plan.cells, 'cell'), plural(plan.attempts, 'attempt'))
  const serial = `~${formatDuration(plan.estimateMs)} serial`
  const parallel = Math.min(plan.concurrency, plan.attempts)
  parts.push(
    parallel > 1
      ? `${serial} (~${formatDuration(plan.estimateMs / parallel)} at concurrency ${plan.concurrency})`
      : serial,
  )
  const { attempts, duration } = plan.budget
  const caps = [
    attempts !== undefined
      ? `${plural(attempts, 'attempt')} ${plan.attempts <= attempts ? '✓' : '✗'}`
      : '',
    duration !== undefined ? `${duration}` : '',
  ].filter(Boolean)
  if (caps.length) parts.push(`budget ${caps.join(', ')}`)
  return `plan  ${parts.join(' · ')}`
}

/**
 * The `--dry-run` table: one row per planned eval, then one per placeholder in `todos`. A pooled
 * family's cases are one row, under its template.
 */
export function planTable(plan: RunPlan, todos: readonly string[] = []): string[] {
  const header = ['eval', 'harnesses', 'variants', 'runs', 'attempts', 'notes']
  const groups: Array<{ id: string; members: PlanRow[] }> = []
  for (const row of plan.rows) {
    const family = row.family?.id
    const group = family && groups.find((g) => g.id === family)
    if (group) group.members.push(row)
    else groups.push({ id: family ?? row.id, members: [row] })
  }
  const rows = groups.map(({ id, members }) => {
    const p = (members.find((m) => !m.plan.skip) ?? (members[0] as PlanRow)).plan
    const family = members[0]?.family
    const live = members.filter((m) => !m.plan.skip)
    const attempts = live.reduce((sum, m) => sum + m.plan.attempts, 0)
    const pooled = family
      ? [
          `${live.length === family.cases ? family.cases : `${live.length} of ${family.cases}`} cases · ${p.variants === null ? 'pooled pass rate' : 'paired lift'}`,
        ]
      : []
    return [
      clip(id, 64),
      String(p.harnesses),
      p.variants === null
        ? '—'
        : p.variants.run === p.variants.of
          ? String(p.variants.run)
          : `${p.variants.run} of ${p.variants.of}`,
      String(p.runs),
      String(family ? attempts : p.attempts),
      [
        live.length === 0 && p.skip ? `skipped: ${p.skip}` : '',
        ...pooled,
        ...p.notes,
        p.brokered.length ? `brokered: ${p.brokered.join('; ')}` : '',
        p.egress.length ? `egress: ${p.egress.join('; ')}` : '',
        p.workspaces.length ? `workspace: ${p.workspaces.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    ]
  })
  for (const id of todos) rows.push([clip(id, 64), '—', '—', '0', '0', 'todo'])
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cols: string[]) =>
    cols
      .map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd()
  return [
    line(header),
    ...rows.flatMap((row, i) => {
      const g = groups[i]
      return [line(row), ...(g ? questionLines(g.members, plan.questionModel) : [])]
    }),
  ]
}

export type PlanCell = Cell & {
  gate: CellGate
  minLift?: number
  runs: number
  /** Secrets its attempts broker, as `NAME → host, host`. */
  brokered: string[]
  egress: PlannedEgress
  /** The git repository its workspace starts as; unset for an empty workspace. */
  workspace?: { repo: string; ref: string | null; path: string | null }
  /** The paths its environment's `files` write (`directory()`'s included), sorted. */
  files?: string[]
}

export type PlanEval = {
  id: string
  file: string
  groups: string[]
  name: string
  tags: string[]
  /** Why the eval doesn't run at all, else null. */
  skip: string | null
  notes: string[]
  cells: PlanCell[]
  /** The compare's questions, answered after the run; unset without any. */
  questions?: PlanQuestion[]
  /** Set on each case of a pooled `evaluate.each`. */
  family?: FamilyMeta
}

/** A Docker sandbox image the plan needs, and how it's made, as `reeval image build --dry-run` lists it. */
export type PlanImage = {
  id: string
  /** Whose CLI the image carries. */
  harness: string
  evals: number
  stages: Array<{ what: string; ref: string; action: string }>
}

/** `reeval run --dry-run --json`: the plan as one document. */
export type PlanDocument = {
  /** Minted or resumed before the plan was collected. */
  runId?: string
  profile: { name: string; reason: string } | null
  /** Set when `--resume` continues a previous run. */
  resume?: { runId: string; completed: number }
  totals: { evals: number; skipped: number; cells: number; attempts: number }
  budget: { attempts: number | null; duration: Duration | null; fits: boolean }
  concurrency: number
  estimateMs: number
  warnings: string[]
  /** Sandboxes that run as root or with capabilities added back, one per level that set them. */
  sandboxWarnings: SandboxWarning[]
  hints: string[]
  evals: PlanEval[]
  excluded: ExcludedEval[]
  images: PlanImage[]
}

export function planDocument(
  plan: RunPlan,
  planned: PlannedItem[],
  excluded: ExcludedEval[],
  images: PlanImage[],
): PlanDocument {
  const evals = new Map<string, PlanEval>()
  for (const { id, file, attempt } of planned) {
    let e = evals.get(id)
    if (!e) {
      const questions = planQuestions(
        attempt.plan.questions,
        plan.rows.find((r) => r.id === id)?.sides ?? [],
        plan.questionModel,
        attempt.plan.skip,
      )
      e = {
        id,
        file,
        groups: attempt.groups,
        name: attempt.name,
        tags: attempt.tags,
        skip: attempt.plan.skip ?? null,
        notes: attempt.plan.notes,
        cells: [],
        ...(questions.length ? { questions } : {}),
        ...(attempt.family ? { family: attempt.family } : {}),
      }
      evals.set(id, e)
    }
    if (attempt.skip || attempt.plan.skip) continue
    const cell = e.cells.find((c) => c.key === attempt.cell.key)
    if (cell) cell.runs++
    else {
      e.cells.push({
        ...attempt.cell,
        gate: attempt.gate,
        ...(attempt.minLift !== undefined ? { minLift: attempt.minLift } : {}),
        runs: 1,
        brokered: attempt.brokered,
        egress: attempt.egress,
        ...(attempt.workspace && {
          workspace: {
            repo: attempt.workspace.repo,
            ref: attempt.workspace.ref ?? null,
            path: attempt.workspace.path ?? null,
          },
        }),
        ...(attempt.files && { files: attempt.files }),
      })
    }
  }
  const { attempts, duration } = plan.budget
  return {
    ...(plan.runId ? { runId: plan.runId } : {}),
    profile: plan.profile && { name: plan.profile.name, reason: plan.profile.reason },
    ...(plan.resume ? { resume: plan.resume } : {}),
    totals: {
      evals: plan.evals,
      skipped: plan.rows.length - plan.evals,
      cells: plan.cells,
      attempts: plan.attempts,
    },
    budget: {
      attempts: attempts ?? null,
      duration: duration ?? null,
      fits: attempts === undefined || plan.attempts <= attempts,
    },
    concurrency: plan.concurrency,
    estimateMs: plan.estimateMs,
    warnings: plan.warnings,
    sandboxWarnings: plan.sandboxWarnings,
    hints: plan.hints,
    evals: [...evals.values()],
    excluded,
    images,
  }
}

/** Exit 2 before anything starts when the plan is over `budget.attempts` (unless `--force`). */
export function checkAttemptBudget(plan: RunPlan, force: boolean, configFile: string): void {
  const cap = plan.budget.attempts
  if (cap === undefined || plan.attempts <= cap || force) return
  const where = plan.profile ? `profile ${plan.profile.name}` : configFile
  throw new UsageError(
    `this run plans ${plan.attempts} attempts, over budget.attempts ${cap} (${where}). Narrow it with --tag or --runs, or raise the budget. (--force runs it anyway)`,
  )
}
