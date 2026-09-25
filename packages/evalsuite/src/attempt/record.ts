import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { allowedHosts } from '../egress.ts'
import { isTimeout } from '../errors.ts'
import { attemptKey, recordFileName } from '../ids.ts'
import { redactSecrets } from '../redact.ts'
import { InfraError, type Sandbox } from '../sandbox/index.ts'
import { clip } from '../text.ts'
import type { ErrorKind, EvalMeta } from '../types.ts'
import type { Attempt } from './state.ts'

function classify(error: unknown, signal: AbortSignal): { kind: ErrorKind; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (signal.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason)
    return isTimeout(reason)
      ? { kind: 'timeout', message: 'The eval timed out' }
      : { kind: 'aborted', message: 'The run was cancelled' }
  }
  if (error instanceof InfraError) return { kind: 'infra', message }
  return { kind: 'assertion', message }
}

/**
 * Why the attempt failed, into the record: the eval's own timeout, a cancel, an infra error, or an
 * assertion, which is the judge's when a judge call failed or gave a failing verdict.
 */
export function recordFailure(a: Attempt, error: unknown, timedOut: boolean): void {
  const { record } = a
  record.error = timedOut
    ? { kind: 'timeout', message: 'The eval timed out' }
    : classify(error, a.signal)
  const judgeFailed = a.judgeErrored || record.judgements.some((j) => j.verdict !== 'pass')
  if (record.error.kind === 'assertion' && judgeFailed) record.error.kind = 'judge'
  record.outcome = record.error.kind === 'infra' ? 'infra_error' : 'fail'
}

/** The attempt's egress policy and, when its sandbox records it, what it contacted and was refused. */
export function recordEgress(a: Attempt, sandbox: Sandbox | undefined): void {
  const traffic = sandbox?.traffic?.()
  a.record.egress = {
    policy: a.spec.egress.policy,
    allowed: allowedHosts(a.spec.egress),
    recorded: !!traffic,
    contacted: traffic?.contacted ?? [],
    blocked: traffic?.blocked ?? [],
  }
}

/** Phase 6: writes the attempt's record, redacted, and returns what the runner reports. */
export async function writeRecord(a: Attempt, stagingDir: string, id: string): Promise<EvalMeta> {
  const { record, spec } = a
  const recordPath = join(
    stagingDir,
    'evals',
    recordFileName(attemptKey(id, spec.cell.key, spec.n)),
  )
  await mkdir(join(stagingDir, 'evals'), { recursive: true })
  await writeFile(recordPath, redactSecrets(JSON.stringify(record, null, 2)))
  return {
    outcome: record.outcome,
    errorKind: record.error?.kind ?? null,
    judgements: record.judgements.map((j) => ({
      verdict: j.verdict,
      score: j.score,
      threshold: j.threshold,
      question: clip(j.question, 200),
    })),
  }
}
