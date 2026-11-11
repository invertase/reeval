import { readFile } from 'node:fs/promises'
import { classifyAttempt } from '../history/db.ts'
import type { AttemptRecord, RunRecord } from '../history/types.ts'
import type { AttemptFacts } from '../view/api.ts'
import { attemptFacts } from '../view/run-view.ts'
import { resolveFile, type StudioSource } from './source.ts'

/** An attempt's kept transcript, or null when it wasn't kept or can't be read. */
export async function readTranscript(
  source: StudioSource,
  runId: string,
  attempt: AttemptRecord,
): Promise<string | null> {
  const ref = attempt.files.transcript
  if (!ref) return null
  const file = await resolveFile(source, { kind: 'artifact', runId, segments: ref.path.split('/') })
  return file ? readFile(file, 'utf8').catch(() => null) : null
}

/** One attempt's facts from its transcript, classified as `history.db` classifies its calls. */
export function factsOf(
  record: RunRecord,
  attempt: AttemptRecord,
  transcript: string,
): AttemptFacts {
  const digest = record.evals
    .find((e) => e.attempts.includes(attempt))
    ?.cells.find((c) => c.key === attempt.cell)?.environmentDigest
  const env = record.environments.find((x) => x.digest === digest)
  const { calls } = classifyAttempt(
    attempt,
    { skills: env?.skills.map((s) => s.name) ?? [], mcp: env?.mcp ?? [] },
    transcript,
  )
  return attemptFacts(calls)
}

/** Every attempt's facts whose transcript was kept, by attempt key. */
export async function runFacts(
  source: StudioSource,
  record: RunRecord,
): Promise<Map<string, AttemptFacts>> {
  const facts = new Map<string, AttemptFacts>()
  for (const e of record.evals) {
    for (const a of e.attempts) {
      const transcript = await readTranscript(source, record.runId, a)
      if (transcript !== null) facts.set(a.key, factsOf(record, a, transcript))
    }
  }
  return facts
}
