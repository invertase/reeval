// The run files `reeval mcp` reads beside the records: transcripts, setup and check logs.
import { readFile } from 'node:fs/promises'
import type { AttemptRecord, RunRecord } from '../history/types.ts'
import { resolveFile, type StudioSource } from '../studio/source.ts'
import type { ResolvedConfig } from '../types.ts'
import type { TranscriptLine } from '../view/model.ts'
import { readableTranscriptLine } from '../view/record.ts'

export const source = (config: ResolvedConfig): StudioSource => ({
  root: config.root,
  historyDir: config.history.dir,
  scratch: true,
})

/** The attempt `ref` names in `run`: its key, or an attempt id (`<cell>#<n>`) unique in the run. */
export function findAttempt(run: RunRecord, ref: string) {
  const attempts = run.evals.flatMap((e) => e.attempts)
  const exact = attempts.find((a) => a.key === ref)
  if (exact) return exact
  const byId = attempts.filter((a) => a.id === ref)
  if (byId.length === 1 && byId[0]) return byId[0]
  const keys = attempts.map((a) => a.key)
  const listed = `${keys.slice(0, 20).join('; ')}${keys.length > 20 ? `; … ${keys.length - 20} more` : ''}`
  throw new Error(
    byId.length > 1
      ? `"${ref}" is an attempt of ${byId.length} evals in ${run.runId}; use its key: ${byId.map((a) => a.key).join('; ')}`
      : `No attempt "${ref}" in ${run.runId}. Attempts: ${listed}`,
  )
}

/** The path of a file the run kept, or null when it wasn't kept. */
export async function runFile(config: ResolvedConfig, run: RunRecord, path: string | undefined) {
  if (!path) return null
  return resolveFile(source(config), {
    kind: 'artifact',
    runId: run.runId,
    segments: path.split('/'),
  })
}

/** The attempt's transcript lines, or null when the run kept no transcript for it. */
export async function transcriptLines(
  config: ResolvedConfig,
  run: RunRecord,
  attempt: AttemptRecord,
): Promise<TranscriptLine[] | null> {
  const file = await runFile(config, run, attempt.files.transcript?.path)
  if (!file) return null
  const lines: TranscriptLine[] = []
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue
    try {
      lines.push(readableTranscriptLine(JSON.parse(line) as TranscriptLine))
    } catch {}
  }
  return lines
}

export async function readTranscript(config: ResolvedConfig, run: RunRecord, ref: string) {
  const attempt = findAttempt(run, ref)
  const lines = await transcriptLines(config, run, attempt)
  if (!lines) {
    throw new Error(
      `${run.runId} kept no transcript for ${attempt.key} (recorded with --artifacts failures or none?)`,
    )
  }
  return { attempt, lines }
}

/** The last `chars` characters of a kept file, from a line start; null when it wasn't kept. */
export async function fileTail(
  config: ResolvedConfig,
  run: RunRecord,
  path: string | undefined,
  chars: number,
): Promise<string | null> {
  const file = await runFile(config, run, path)
  if (!file) return null
  const text = (await readFile(file, 'utf8')).trimEnd()
  if (text.length <= chars) return text
  const cut = text.slice(-chars)
  const nl = cut.indexOf('\n')
  return `…${nl >= 0 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut}`
}
