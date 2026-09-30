import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PlanDocument } from '../../src/plan.ts'
import { runCli } from '../helpers.ts'
import { fixture, testDir } from './fixture.ts'

export type PlanCase = {
  /** Under `test/plan/`; several cases can share one directory. */
  dir: string
  name: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

/** `reeval run --dry-run --json` in a copy of the case's directory: exit 0 and one JSON document. */
export async function planJson(c: Omit<PlanCase, 'name'>): Promise<PlanDocument> {
  const p = await fixture(`plan/${c.dir}`)
  const r = await runCli(p.dir, ['run', '--dry-run', '--json', ...c.args], {
    ...(c.env ? { env: c.env } : {}),
  })
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(existsSync(join(p.dir, '.reeval/runs')), false, 'a dry run writes no run')
  try {
    return JSON.parse(r.stdout) as PlanDocument
  } catch (error) {
    throw new Error(
      `reeval run --dry-run --json printed ${r.stdout.length} characters that aren't one JSON document (${(error as Error).message}):\n${r.stdout.slice(0, 400)}\n…\n${r.stdout.slice(-400)}\nstderr:\n${r.stderr}`,
    )
  }
}

/** Aligns columns; a short row (a skipped eval) only shares the first column's width. */
const table = (rows: string[][]) => {
  const full = Math.max(...rows.map((r) => r.length))
  const widths = Array.from({ length: full }, (_, i) =>
    Math.max(...rows.filter((r) => i === 0 || r.length === full).map((r) => r[i]?.length ?? 0)),
  )
  return rows.map((r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd(),
  )
}

/**
 * The plan as a text matrix for review diffs: one line per cell, without the host-dependent
 * estimate and concurrency.
 */
export function renderPlan(plan: PlanDocument): string {
  const { totals, budget } = plan
  const head = [
    plan.profile ? `profile ${plan.profile.name} (${plan.profile.reason})` : 'no profile',
    `${totals.evals} evals${totals.skipped ? ` (${totals.skipped} skipped)` : ''}`,
    `${totals.cells} cells`,
    `${totals.attempts} attempts`,
  ]
  const caps = [
    budget.attempts === null ? '' : `attempts ${budget.attempts}`,
    budget.duration === null ? '' : `duration ${budget.duration}`,
  ].filter(Boolean)
  if (caps.length) head.push(`budget ${caps.join(', ')} ${budget.fits ? '✓' : '✗'}`)
  const rows: string[][] = []
  for (const e of plan.evals) {
    const tags = e.tags.length ? ` [${e.tags.join(', ')}]` : ''
    if (e.skip) {
      rows.push([`${e.id}${tags}`, `skipped: ${e.skip}`])
      continue
    }
    e.cells.forEach((c, i) => {
      rows.push([
        i === 0 ? `${e.id}${tags}` : '',
        c.key,
        c.role === 'variant' ? `variant ${c.variant}` : 'control',
        c.gate === 'none'
          ? 'ungated'
          : c.gate === 'all'
            ? 'gated'
            : `gated passRate ${c.gate.passRate}`,
        `×${c.runs}`,
        [
          c.minLift === undefined ? '' : `minLift ${c.minLift}`,
          ...(i === 0 ? e.notes : []),
          c.brokered.length ? `brokered: ${c.brokered.join('; ')}` : '',
          c.workspace
            ? `workspace ${c.workspace.repo}${c.workspace.ref ? `#${c.workspace.ref}` : ''}${c.workspace.path ? `:${c.workspace.path}` : ''}`
            : '',
          c.files ? `files ${c.files.join(', ')}` : '',
          c.egress.policy === 'allow-all'
            ? ''
            : `egress ${JSON.stringify(c.egress.policy)}${c.egress.auto.length ? ` + ${c.egress.auto.join(', ')}` : ''}`,
        ]
          .filter(Boolean)
          .join(' · '),
      ])
    })
    for (const q of e.questions ?? []) {
      rows.push(['', `question: ${q.question} · ${q.model ?? 'no language model'}`])
    }
  }
  const excluded = plan.excluded.map((x) => `${x.id} (${x.mode})`)
  const images = plan.images.flatMap((image) => [
    `image ${image.id} · ${image.evals} evals`,
    ...table(image.stages.map((s) => [`  ${s.what}`, s.ref, `(${s.action})`])),
  ])
  return [
    head.join(' · '),
    ...plan.sandboxWarnings.map(
      (w) =>
        `${w.kind === 'root' ? 'WARNING' : 'warning'}: ${w.message} [${w.level}${w.file ? ` ${w.file}` : ''}]`,
    ),
    ...plan.warnings.map((w) => `warning: ${w}`),
    ...plan.hints.map((h) => `hint: ${h}`),
    ...table(rows),
    `excluded: ${excluded.length ? excluded.join(', ') : '—'}`,
    ...images,
    '',
  ].join('\n')
}

/** Compares with the snapshot at `test/<path>`; `REEVAL_UPDATE_SNAPSHOTS=1` writes it instead. */
export function matchFile(path: string, actual: string): void {
  const file = join(testDir, path)
  if (process.env.REEVAL_UPDATE_SNAPSHOTS === '1') {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, actual)
    return
  }
  if (!existsSync(file)) {
    assert.fail(
      `No snapshot at test/${path}. Write it with REEVAL_UPDATE_SNAPSHOTS=1, then review it.`,
    )
  }
  assert.equal(
    actual,
    readFileSync(file, 'utf8'),
    `test/${path} (REEVAL_UPDATE_SNAPSHOTS=1 rewrites it)`,
  )
}
