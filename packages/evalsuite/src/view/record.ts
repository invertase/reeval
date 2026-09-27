import type { RunRecord } from '../history/types.ts'

type Written = RunRecord & {
  plan: { sandboxWarnings?: RunRecord['plan']['sandboxWarnings'] }
  stack: { harnesses: Array<{ resolvedModels?: string[] }> }
  evals: Array<{ todo?: boolean }>
}

/**
 * A record as every reader sees it: a field added after the record was written reads as its empty
 * value, so older runs keep loading in `es show`, `es query`, compare, history and the studio.
 */
export function readableRecord(record: RunRecord): RunRecord {
  const r = record as Written
  r.plan.sandboxWarnings ??= []
  for (const h of r.stack.harnesses) h.resolvedModels ??= []
  for (const e of r.evals) e.todo ??= false
  return record
}
