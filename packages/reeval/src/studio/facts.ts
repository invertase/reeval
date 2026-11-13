import { readFile } from 'node:fs/promises'
import type { AttemptRecord, RunRecord } from '../history/types.ts'
import { resolveFile, type StudioSource } from './source.ts'

/** An attempt's kept transcript, or undefined when it wasn't kept or can't be read. */
export async function readTranscript(
  source: StudioSource,
  runId: string,
  attempt: AttemptRecord,
): Promise<string | undefined> {
  const ref = attempt.files.transcript
  if (!ref) return undefined
  const file = await resolveFile(source, { kind: 'artifact', runId, segments: ref.path.split('/') })
  return file ? readFile(file, 'utf8').catch(() => undefined) : undefined
}

/** Every attempt's kept transcript, by attempt key: what `buildRunView` computes facts from. */
export async function runTranscripts(
  source: StudioSource,
  record: RunRecord,
): Promise<Map<string, string>> {
  const transcripts = new Map<string, string>()
  for (const e of record.evals) {
    for (const a of e.attempts) {
      const transcript = await readTranscript(source, record.runId, a)
      if (transcript !== undefined) transcripts.set(a.key, transcript)
    }
  }
  return transcripts
}
