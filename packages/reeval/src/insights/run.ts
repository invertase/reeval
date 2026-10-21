// Insights during `reeval run`, once the record has landed and the exit code is fixed: the same
// calls `reeval analyze --insights` makes, bounded by `analysis.maxTokens` and by
// `analysis.insightsTimeout` from the last attempt. They go beside the scratch run as
// `.reeval/runs/<run>/insights.json`, and `reeval record` copies them into the history. Whatever
// happens here (no key, a model that fails, the clock running out), the run prints its facts and
// keeps its exit code; this only ever adds a line saying why there are no insights.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveAnalysisModel } from '../analysis/model.ts'
import { parseDuration } from '../duration.ts'
import { renderSummary } from '../history/summary.ts'
import type { RunRecord } from '../history/types.ts'
import { clip } from '../text.ts'
import type { ResolvedConfig } from '../types.ts'
import type { RunInsights } from '../view/insights.ts'
import { INSIGHTS_FILE } from '../view/insights.ts'
import { suiteResult } from '../view/suite.ts'
import { classifyCache } from './classify.ts'
import { writeInsights } from './files.ts'
import { type CallUsage, generateInsights, insightEvals } from './generate.ts'

/** Evals asked about at once during a run: the tail after the last attempt is the wait. */
export const RUN_CONCURRENCY = 8

export type RunInsightsResult = {
  insights: RunInsights | null
  /** Why there are none, or what's missing: lines printed above the tally. */
  lines: string[]
}

/** Whether this run writes insights: `analysis.model` set, `analysis.insights` on, no `--no-insights`. */
export const wantsInsights = (config: ResolvedConfig, flag: boolean) =>
  config.analysis.model !== undefined && config.analysis.insights && flag

export async function runInsights(options: {
  config: ResolvedConfig
  record: RunRecord
  /** The scratch run's folder, `.reeval/runs/<run>`: transcripts in, insights out. */
  runDir: string
  /** The line saying insights have started, once there's something to ask about. */
  onStart?: (text: string) => void
  onUsage?: (call: CallUsage) => void
}): Promise<RunInsightsResult> {
  const { config, record, runDir } = options
  const retry = `reeval analyze ${record.runId} --insights`
  const evals = insightEvals(suiteResult(record)).length
  if (!evals) return { insights: null, lines: [] }
  let model: ReturnType<typeof resolveAnalysisModel>
  try {
    model = resolveAnalysisModel(config)
  } catch (error) {
    return { insights: null, lines: [`insights skipped: ${clip((error as Error).message, 240)}`] }
  }
  const timeout = config.analysis.insightsTimeout
  options.onStart?.(
    `insights: ${evals === 1 ? '1 eval' : `${evals} evals`} with ${model.name} (up to ${timeout}; --no-insights skips them)`,
  )
  const abort = new AbortController()
  const timer = setTimeout(
    () => abort.abort(new Error(`insights took longer than analysis.insightsTimeout (${timeout})`)),
    parseDuration(timeout),
  )
  let insights: RunInsights
  try {
    insights = await generateInsights({
      record,
      runDir,
      model,
      maxOutputTokens: config.analysis.maxOutputTokens,
      maxTokens: config.analysis.maxTokens,
      concurrency: RUN_CONCURRENCY,
      cache: classifyCache(config.root, config.history.dir),
      signal: abort.signal,
      ...(options.onUsage ? { onUsage: options.onUsage } : {}),
    })
  } catch (error) {
    if (abort.signal.aborted) {
      return {
        insights: null,
        lines: [
          `insights still running after ${timeout}, so they're left out: raise analysis.insightsTimeout in reeval.config.ts, or run ${retry}`,
        ],
      }
    }
    return {
      insights: null,
      lines: [`insights failed (${clip((error as Error).message, 200)}): ${retry} to retry`],
    }
  } finally {
    clearTimeout(timer)
  }
  try {
    await writeInsights(join(runDir, INSIGHTS_FILE), insights)
    await writeFile(join(runDir, 'summary.md'), renderSummary(record, { hint: false, insights }))
  } catch (error) {
    return {
      insights,
      lines: [`insights weren't written: ${clip((error as Error).message, 200)}`],
    }
  }
  return { insights, lines: [] }
}
