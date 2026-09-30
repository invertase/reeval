// `analysis.agent` during `reeval run`: a note on each eval and harness as soon as that harness's
// attempts of the eval (every run) have finished, on the host, from the staged records. The run
// awaits them before it's written. Once it is, one summary of the whole run goes into the analysis
// cache (`summary.ts`). Neither changes an outcome or the exit code.
import type { PlannedItem } from '../../engine/types.ts'
import { fromCwd } from '../../ids.ts'
import type { ResolvedConfig } from '../../types.ts'
import type { EvalResult } from '../../ui/events.ts'
import type { AnalysisNote } from '../../view/analysis.ts'
import { notesDir, writeNote } from '../files.ts'
import type { ResolvedAnalysisModel } from '../model.ts'
import { writeAgentNote } from './note.ts'
import { stagedAttempts } from './tools.ts'

export type NoteRun = {
  /** Every attempt's result, as it ends. */
  onResult(result: EvalResult): void
  /**
   * Starts the notes whose attempts never all reported (a filter or a budget left some out), then
   * waits for every note. With `cancelled`, stops the calls in flight and writes nothing more.
   */
  finish(cancelled: boolean): Promise<AnalysisNote[]>
}

type Options = {
  config: ResolvedConfig
  model: ResolvedAnalysisModel
  runId: string
  stagingDir: string
  planned: PlannedItem[]
  /** A warning line: a note that failed, or couldn't be written. */
  warn(text: string): void
}

/** Notes in flight at once: a run with many evals and harnesses doesn't burst the provider. */
const MAX_NOTES = 4

const groupKey = (evalId: string, harness: string) => `${evalId}\0${harness}`

export function startNotes({ config, model, runId, stagingDir, planned, warn }: Options): NoteRun {
  const expected = new Map<string, number>()
  const order = new Map(planned.map((p, i) => [p.key, i]))
  for (const p of planned) {
    if (p.attempt.plan.skip) continue
    const key = groupKey(p.id, p.attempt.cell.harness)
    expected.set(key, (expected.get(key) ?? 0) + 1)
  }
  const finished = new Map<string, EvalResult[]>()
  const started = new Set<string>()
  const pending: Array<Promise<AnalysisNote | null>> = []
  const abort = new AbortController()
  // A slot is handed straight to the next note waiting, so no more than MAX_NOTES run at once.
  let running = 0
  const waiting: Array<() => void> = []
  const slot = async () => {
    if (running < MAX_NOTES) running++
    else await new Promise<void>((resolve) => waiting.push(resolve))
  }
  const release = () => {
    const next = waiting.shift()
    if (next) next()
    else running--
  }

  const start = (key: string) => {
    // In plan order, not the order they happened to finish in.
    const results = (finished.get(key) ?? []).sort(
      (a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0),
    )
    started.add(key)
    const first = results[0]
    // Nothing ran (all skipped by a budget or a cancel): nothing to write about.
    if (!first?.attempt || results.every((r) => r.state === 'skipped')) return
    const harness = first.attempt.cell.harness
    const about = `analysis note on ${first.id} (${harness})`
    pending.push(
      (async () => {
        await slot()
        try {
          if (abort.signal.aborted) return null
          const note = await writeAgentNote({
            model,
            runId,
            evalId: first.id,
            harness,
            attempts: await stagedAttempts(stagingDir, results),
            maxInputTokens: config.analysis.maxInputTokens,
            maxOutputTokens: config.analysis.maxOutputTokens,
            ...(config.analysis.instructions ? { instructions: config.analysis.instructions } : {}),
            signal: abort.signal,
          })
          if (abort.signal.aborted) return null
          if (note.error) warn(`${about} failed: ${note.error}`)
          await writeNote(config.root, note)
          return note
        } catch (error) {
          if (!abort.signal.aborted) warn(`${about} wasn't written: ${(error as Error).message}`)
          return null
        } finally {
          release()
        }
      })(),
    )
  }

  return {
    onResult(result) {
      if (!result.attempt || abort.signal.aborted) return
      const key = groupKey(result.id, result.attempt.cell.harness)
      if (!expected.has(key) || started.has(key)) return
      const results = [...(finished.get(key) ?? []), result]
      finished.set(key, results)
      if (results.length >= (expected.get(key) ?? 0)) start(key)
    },
    async finish(cancelled) {
      if (cancelled) abort.abort(new Error('The run was cancelled'))
      else for (const key of finished.keys()) if (!started.has(key)) start(key)
      const notes = (await Promise.all(pending)).filter((n): n is AnalysisNote => n !== null)
      return notes
    },
  }
}

/**
 * Writes the run's summary into the analysis cache, once the run is written; the line to print.
 * A failure is a warning: the run's outcomes and exit code stand.
 */
export async function summarizeRun(
  config: ResolvedConfig,
  runId: string,
  model: ResolvedAnalysisModel,
): Promise<{ level: 'info' | 'warn'; text: string }> {
  try {
    const { writeRunSummary } = await import('./summary.ts')
    const { doc, path } = await writeRunSummary({ config, runId, model })
    if (doc.error) return { level: 'warn', text: `analysis summary failed: ${doc.error}` }
    return {
      level: 'info',
      text: `analysis: summary in ${fromCwd(path)} (reeval analyze shows it)`,
    }
  } catch (error) {
    return { level: 'warn', text: `analysis summary wasn't written: ${(error as Error).message}` }
  }
}

/** The line the run prints once its notes are written. */
export const notesLine = (root: string, runId: string, notes: AnalysisNote[]) => {
  const failed = notes.filter((n) => n.error).length
  const n = notes.length
  return `analysis: ${n} note${n === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''} in ${fromCwd(notesDir(root, runId))}`
}
