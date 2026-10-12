import { mkdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { attemptKey, evalId, recordFileName } from '../../src/ids.ts'
import type { EvalRecord } from '../../src/types.ts'

/** A valid run id the tests seed leftover staging with. */
export const SEEDED_RUN_ID = '20260101T000000Z_nogit_test_abcd'

const PASS: EvalRecord = {
  outcome: 'pass',
  error: null,
  startedAt: '2026-01-01T00:00:00.000Z',
  turns: [],
  diff: null,
  checks: [],
  judgements: [],
  timings: { setupMs: 0, agentMs: 0, diffMs: 0, checksMs: 0, judgeMs: 0 },
}

/** Stopped leftover staging: stale heartbeat, a pid that is not this process. */
export function writeStoppedStaging(
  root: string,
  runId: string,
  completed: ReadonlyArray<{ file: string; name: string; cell: string; n?: number }> = [],
): string {
  const staging = join(root, '.reeval', 'staging', runId)
  mkdirSync(join(staging, 'evals'), { recursive: true })
  writeFileSync(
    join(staging, 'live.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      runId,
      startedAt: '2026-01-01T00:00:00.000Z',
      pid: 2_000_000_000,
      host: hostname(),
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      phase: 'running',
      planned: 0,
      counts: { done: 0, passed: 0, failed: 0, errored: 0, skipped: 0, running: 0 },
      attempts: [],
    })}\n`,
  )
  for (const c of completed) {
    const key = attemptKey(evalId(c.file, [c.name]), c.cell, c.n ?? 1)
    writeFileSync(join(staging, 'evals', recordFileName(key)), `${JSON.stringify(PASS, null, 2)}\n`)
  }
  return staging
}

export function writeScratch(
  root: string,
  runId: string,
  status: 'complete' | 'interrupted' | 'budget',
  attempts: ReadonlyArray<{ key: string; outcome: 'pass' | 'fail' | 'skipped' | 'infra_error' }> = [],
): void {
  mkdirSync(join(root, '.reeval', 'runs'), { recursive: true })
  writeFileSync(
    join(root, '.reeval', 'runs', `${runId}.json`),
    `${JSON.stringify({
      kind: 'es-run',
      runId,
      status,
      startedAt: '2026-01-01T00:00:00.000Z',
      evals: [{ attempts: attempts.map((a) => ({ ...a, error: null })) }],
    })}\n`,
  )
}
