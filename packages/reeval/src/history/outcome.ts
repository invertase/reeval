import type { EngineEval } from '../engine/node.ts'
import { isTimeout } from '../errors.ts'
import type { EvalRecord, Outcome } from '../types.ts'

type Merged = Pick<EvalRecord, 'error'> & { outcome: Outcome }

/** The engine and the worker's record can disagree, e.g. when a timeout fails the eval first. */
export function mergeOutcome(e: EngineEval, record: EvalRecord | null): Merged {
  // A resume skips a completed attempt: keep the staged (or previous) outcome, including pass.
  if (e.state === 'skipped' && record) return { outcome: record.outcome, error: record.error }
  if (e.state === 'skipped') return { outcome: 'skipped', error: null }
  // An unhandled mid-turn error is reclassified to infra_error without throwing, so the engine
  // still reports `passed`; only the worker record carries that infra_error.
  if (e.state === 'passed') {
    if (record?.outcome === 'infra_error') return { outcome: 'infra_error', error: record.error }
    return { outcome: 'pass', error: null }
  }
  const message = e.errors[0] ?? 'Eval failed'
  // The worker's own classification wins: a setup InfraError whose message says "timed out"
  // isn't the eval's timeout. Without a record, the engine's error name is all there is.
  const error =
    record?.error ??
    (isTimeout({ name: e.errorName })
      ? { kind: 'timeout' as const, message }
      : { kind: 'assertion' as const, message })
  return { outcome: record?.outcome === 'infra_error' ? 'infra_error' : 'fail', error }
}
