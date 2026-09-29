// The record corpus's real-harness runs from the nightly contract (real.yml), attempt by attempt:
// `real-e2e-pairs` holds two recorded runs of one eval per harness, and `real-contract` one run of
// the harness contract per harness, with passing checks and failing canaries. Key-free readers of
// real transcripts and diffs build on these.
import { join } from 'node:path'
import type { AttemptRecord, EvalEntry, RunRecord } from '../../src/history/types.ts'
import { readableRecord } from '../../src/view/record.ts'
import { corpusEntries } from './corpus.ts'

export const REAL_ENTRIES = ['real-e2e-pairs', 'real-contract'] as const
export type RealEntry = (typeof REAL_ENTRIES)[number]

/** The harnesses both entries hold, by `harnessKind`. */
export const REAL_HARNESSES = ['cursor', 'claude-code', 'codex'] as const

export type RealAttempt = {
  entry: RealEntry
  runId: string
  /** The run's record, read the way reeval reads it. */
  record: RunRecord
  eval: EvalEntry
  attempt: AttemptRecord
  /** The attempt's cell's `harnessKind`, e.g. `cursor`. */
  harness: string
  /** Absolute paths into the corpus; absent when the attempt never reached the agent. */
  transcript?: string
  diff?: string
}

/** Every attempt of the real-harness entries (or the one named), runs oldest first. */
export function realAttempts(only?: RealEntry): RealAttempt[] {
  const out: RealAttempt[] = []
  for (const entry of corpusEntries()) {
    const name = entry.name as RealEntry
    if (!REAL_ENTRIES.includes(name) || (only && only !== name)) continue
    for (const run of entry.runs) {
      const record = readableRecord(structuredClone(run.raw) as never)
      const dir = join(entry.dir, 'evals/.history', run.runId)
      for (const e of record.evals) {
        for (const a of e.attempts) {
          const cell = e.cells.find((c) => c.key === a.cell)
          out.push({
            entry: name,
            runId: run.runId,
            record,
            eval: e,
            attempt: a,
            harness: cell?.harnessKind ?? 'unknown',
            ...(a.files.transcript && { transcript: join(dir, a.files.transcript.path) }),
            ...(a.files.diff && { diff: join(dir, a.files.diff.path) }),
          })
        }
      }
    }
  }
  return out
}
