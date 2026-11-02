import type {
  AttemptRecord,
  CellRecord,
  HistoryCell,
  HistoryEntry,
  RunRecord,
} from '../history/types.ts'
import { cellEffort } from './effort.ts'

/** The derived header of one run: what listings, indexes and comparisons need without the record. */
export function runHeader(record: RunRecord, recorded: boolean): HistoryEntry {
  return {
    runId: record.runId,
    recorded,
    status: record.status,
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    author: record.author,
    git: record.git
      ? { sha: record.git.sha, branch: record.git.branch, dirty: record.git.dirty }
      : null,
    runner: record.runner.kind,
    ci:
      record.runner.kind === 'ci'
        ? {
            provider: record.runner.provider,
            runUrl: record.runner.runUrl,
            pr: record.runner.pr,
          }
        : null,
    harnesses: record.stack.harnesses.map((h) => h.id),
    summary: record.summary,
    usage: record.cost.usage,
    stack: {
      imageIds: record.stack.images.map((i) => i.id),
      agentClis: [...new Set(record.stack.images.flatMap((i) => (i.agentCli ? [i.agentCli] : [])))],
      harnesses: record.stack.harnesses.map((h) => h.id),
      environments: record.environments.map(
        (e) => `${e.name}@${e.digest.replace(/^sha256:/, '').slice(0, 12)}`,
      ),
      judgeModel: record.stack.judge.model,
      judgeServed: record.stack.judge.resolvedModels,
      judgeVersion: record.stack.judge.version,
      threshold: record.stack.judge.threshold,
      fingerprintScope: record.stack.fingerprintScope,
    },
    evals: record.evals.map((e) => ({
      id: e.id,
      key: e.key,
      slug: e.slug,
      fingerprint: e.fingerprint,
      sources: e.sources,
      ...(e.source ? { source: e.source } : {}),
      ...(e.revision !== undefined ? { revision: e.revision } : {}),
      outcome: e.outcome,
      passRate: e.passRate,
      cells: e.cells.map((c) => historyCell(e.attempts, c)),
      ...(e.cases
        ? {
            cases: e.cases.map((k) => {
              const attempts = e.attempts.filter((a) => a.case === k.key)
              return {
                key: k.key,
                outcome: k.outcome,
                ...(k.verdict ? { verdict: k.verdict } : {}),
                fingerprint: k.fingerprint,
                ...(k.hash ? { hash: k.hash } : {}),
                cells: k.cells.map((c) => historyCell(attempts, c)),
              }
            }),
            caseCount: e.caseCount ?? e.cases.length,
            ...(e.lifts?.length
              ? {
                  lifts: e.lifts.map((l) => ({
                    variant: l.variant,
                    vs: l.vs,
                    points: l.points,
                    lo: l.interval.lo,
                    hi: l.interval.hi,
                    ...(l.minLift !== undefined ? { minLift: l.minLift } : {}),
                    outcome: l.outcome,
                  })),
                }
              : {}),
            ...gatedRates(e.cells),
          }
        : {}),
    })),
    ...(record.errors?.length ? { errors: record.errors } : {}),
  }
}

/** The cells' rates over the cases that a `gate: { passRate }` gates, when there are any. */
function gatedRates(cells: readonly CellRecord[]) {
  const gated = cells.flatMap(({ key, rate }) =>
    rate?.passRate !== undefined && rate.outcome !== undefined
      ? [{ cell: key, rate: rate.rate, passRate: rate.passRate, outcome: rate.outcome }]
      : [],
  )
  return gated.length ? { rates: gated } : {}
}

function historyCell(attempts: readonly AttemptRecord[], c: CellRecord): HistoryCell {
  return {
    key: c.key,
    role: c.role,
    ...(c.variant !== undefined ? { variant: c.variant } : {}),
    harness: c.harness,
    model: c.model,
    environment: c.environment,
    environmentDigest: c.environmentDigest,
    gate: c.gate,
    fingerprint: c.fingerprint,
    fingerprintParts: c.fingerprintParts,
    runs: c.runs,
    pass: c.pass,
    fail: c.fail,
    infraError: c.infraError,
    skipped: c.skipped,
    passRate: c.passRate,
    outcome: c.outcome,
    effort: cellEffort({ attempts: [...attempts] }, c.key),
    ...canceledIn(attempts, c.key),
    ...(c.lift
      ? {
          lift: {
            vs: c.lift.vs,
            points: c.lift.points,
            lo: c.lift.interval.lo,
            hi: c.lift.interval.hi,
            withinNoise: c.lift.withinNoise,
          },
        }
      : {}),
  }
}

/** A cell's failed attempts that the run's interrupt canceled, when it has any. */
function canceledIn(attempts: readonly AttemptRecord[], cell: string): { canceled?: number } {
  const n = attempts.filter(
    (a) => a.cell === cell && a.outcome === 'fail' && a.error?.kind === 'aborted',
  ).length
  return n ? { canceled: n } : {}
}
