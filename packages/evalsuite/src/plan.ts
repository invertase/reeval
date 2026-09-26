// The run's plan: what it will start, how long that should take, and whether it fits the budget.
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
  PlannedEgress,
  ResolvedProfile,
  SandboxDescriptor,
} from './types.ts'

/** With no history for a harness, an attempt is assumed to take this long (the fake agent: 1s). */
const DEFAULT_ATTEMPT_MS = 3 * 60_000
const DEFAULT_FAKE_MS = 1000
/** The most recent runs whose durations feed the estimate. */
const HISTORY_RUNS = 30

export type PlanRow = { id: string; plan: EvalPlan }

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
  /** Advice that doesn't stop the run, e.g. about the default gate. */
  hints: string[]
  sandboxes: SandboxDescriptor[]
  harnessKinds: string[]
  /** The harness ids the planned attempts run on, for the run header. */
  harnesses: string[]
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
}): Promise<RunPlan> {
  const { planned } = options
  const estimate = await historyDurations(options.root, options.historyDir)
  const rows = new Map<string, PlanRow>()
  const cells = new Set<string>()
  const warnings = new Set<string>()
  const sandboxes = new Map<string, SandboxDescriptor>()
  const kinds = new Set<string>()
  const harnesses = new Set<string>()
  // A filter can leave out some of an eval's cells: each row counts what it actually plans.
  const counted = new Map<string, { harnesses: Set<string>; variants: Set<string>; n: number }>()
  let attempts = 0
  let estimateMs = 0
  for (const { id, attempt } of planned) {
    if (!rows.has(id)) rows.set(id, { id, plan: attempt.plan })
    for (const w of attempt.plan.warnings) warnings.add(w)
    if (attempt.plan.skip) continue
    attempts++
    cells.add(`${id}\0${attempt.cell.key}`)
    estimateMs += estimate(id, attempt.cell.harness, attempt.harness.kind)
    sandboxes.set(JSON.stringify(attempt.sandbox), attempt.sandbox)
    kinds.add(attempt.harness.kind)
    harnesses.add(attempt.cell.harness)
    const row = counted.get(id) ?? { harnesses: new Set(), variants: new Set(), n: 0 }
    row.harnesses.add(attempt.cell.harness)
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
    hints: gateHint([...rows.values()]),
    sandboxes: [...sandboxes.values()],
    harnessKinds: [...kinds],
    harnesses: [...harnesses],
  }
}

/** One line when evals run several times under the default gate, which every attempt must pass. */
function gateHint(rows: PlanRow[]): string[] {
  const n = rows.filter((r) => !r.plan.skip && r.plan.runs > 1 && r.plan.gate === undefined).length
  if (n === 0) return []
  return [
    `${plural(n, 'eval')} ${n === 1 ? 'runs' : 'run'} more than once with the default gate, so every attempt must pass; set gate: { passRate: 0.8 } to gate on a pass rate instead`,
  ]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** `plan  profile pr (auto: CI is set) · 3 evals · 4 cells · 12 attempts · ~9m serial · …` */
export function planLine(plan: RunPlan): string {
  const parts: string[] = []
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

/** One row per eval: what it runs, and what the profile changed. */
export function planTable(plan: RunPlan): string[] {
  const header = ['eval', 'harnesses', 'variants', 'runs', 'attempts', 'notes']
  const rows = plan.rows.map(({ id, plan: p }) => [
    clip(id, 64),
    String(p.harnesses),
    p.variants === null
      ? '—'
      : p.variants.run === p.variants.of
        ? String(p.variants.run)
        : `${p.variants.run} of ${p.variants.of}`,
    String(p.runs),
    String(p.attempts),
    [
      p.skip ? `skipped: ${p.skip}` : '',
      ...p.notes,
      p.brokered.length ? `brokered: ${p.brokered.join('; ')}` : '',
      p.egress.length ? `egress: ${p.egress.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cols: string[]) =>
    cols
      .map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(line)]
}

export type PlanCell = Cell & {
  gate: CellGate
  minLift?: number
  runs: number
  /** Secrets its attempts broker, as `NAME → host, host`. */
  brokered: string[]
  egress: PlannedEgress
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
}

/** A Docker sandbox image the plan needs, and how it's made, as `es image build --dry-run` lists it. */
export type PlanImage = {
  id: string
  /** Whose CLI the image carries. */
  harness: string
  evals: number
  stages: Array<{ what: string; ref: string; action: string }>
}

/** `es run --dry-run --json`: the plan as one document. */
export type PlanDocument = {
  profile: { name: string; reason: string } | null
  totals: { evals: number; skipped: number; cells: number; attempts: number }
  budget: { attempts: number | null; duration: Duration | null; fits: boolean }
  concurrency: number
  estimateMs: number
  warnings: string[]
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
      e = {
        id,
        file,
        groups: attempt.groups,
        name: attempt.name,
        tags: attempt.tags,
        skip: attempt.plan.skip ?? null,
        notes: attempt.plan.notes,
        cells: [],
      }
      evals.set(id, e)
    }
    if (attempt.plan.skip) continue
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
      })
    }
  }
  const { attempts, duration } = plan.budget
  return {
    profile: plan.profile && { name: plan.profile.name, reason: plan.profile.reason },
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
    hints: plan.hints,
    evals: [...evals.values()],
    excluded,
    images,
  }
}

/** Exit 2 before anything starts when the plan is over `budget.attempts` (unless `--force`). */
export function checkAttemptBudget(plan: RunPlan, force: boolean): void {
  const cap = plan.budget.attempts
  if (cap === undefined || plan.attempts <= cap || force) return
  const where = plan.profile ? `profile ${plan.profile.name}` : 'es.config.ts'
  throw new UsageError(
    `this run plans ${plan.attempts} attempts, over budget.attempts ${cap} (${where}). Narrow it with --tag or --runs, or raise the budget. (--force runs it anyway)`,
  )
}
