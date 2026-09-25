// The run's plan: what it will start, how long that should take, and whether it fits the budget.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PlannedItem } from './engine/node.ts'
import { UsageError } from './errors.ts'
import { scratchDir } from './history/files.ts'
import type { RunRecord } from './history/types.ts'
import { clip, formatDuration } from './text.ts'
import type { Budget, EvalPlan, ResolvedProfile, SandboxDescriptor } from './types.ts'

/** With no history for a harness, an attempt is assumed to take this long. */
const DEFAULT_ATTEMPT_MS = 3 * 60_000
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
  sandboxes: SandboxDescriptor[]
  harnessKinds: string[]
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** Attempt durations from the latest recorded and scratch runs, by eval and harness. */
export async function historyDurations(root: string, historyDir: string) {
  const files: string[] = []
  for (const dir of [historyDir, scratchDir(root)]) {
    const names = await readdir(dir).catch(() => [])
    files.push(...names.filter((n) => n.endsWith('.json')).map((n) => join(dir, n)))
  }
  const recent = files
    .sort((a, b) => (a.split('/').at(-1) ?? '').localeCompare(b.split('/').at(-1) ?? ''))
    .slice(-HISTORY_RUNS)
  const byEval = new Map<string, number[]>()
  const byHarness = new Map<string, number[]>()
  const push = (map: Map<string, number[]>, key: string, ms: number) =>
    map.set(key, [...(map.get(key) ?? []), ms])
  for (const file of recent) {
    let record: RunRecord
    try {
      record = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      continue
    }
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
  return (id: string, harness: string) => {
    const own = byEval.get(`${id}\0${harness}`)
    if (own?.length) return median(own)
    const any = byHarness.get(harness)
    return any?.length ? median(any) : DEFAULT_ATTEMPT_MS
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
  let attempts = 0
  let estimateMs = 0
  for (const { id, attempt } of planned) {
    if (!rows.has(id)) rows.set(id, { id, plan: attempt.plan })
    for (const w of attempt.plan.warnings) warnings.add(w)
    if (attempt.plan.skip) continue
    attempts++
    cells.add(`${id}\0${attempt.cell.key}`)
    estimateMs += estimate(id, attempt.cell.harness)
    sandboxes.set(JSON.stringify(attempt.sandbox), attempt.sandbox)
    kinds.add(attempt.harness.kind)
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
    sandboxes: [...sandboxes.values()],
    harnessKinds: [...kinds],
  }
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
    [p.skip ? `skipped: ${p.skip}` : '', ...p.notes].filter(Boolean).join(' · '),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cols: string[]) =>
    cols
      .map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(line)]
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
