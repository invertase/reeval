import type { HistoryEntry, RunRecord } from '../history/types.ts'
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
      outcome: e.outcome,
      passRate: e.passRate,
      cells: e.cells.map((c) => ({
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
        effort: cellEffort(e, c.key),
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
      })),
    })),
    ...(record.families?.length
      ? {
          families: record.families.map(({ id, name, cases, ran, outcome }) => ({
            id,
            name,
            cases,
            ran,
            outcome,
          })),
        }
      : {}),
    ...(record.errors?.length ? { errors: record.errors } : {}),
  }
}
