// Insights during `reeval run`, once the record has landed and the exit code is fixed: the same
// calls `reeval analyze --insights` makes, bounded by `analysis.maxTokens`, each eval's input and
// output caps and each call's timeout, and run to the end unless Ctrl-C stops them. They go beside
// the scratch run as `.reeval/runs/<run>/insights.json`, with the run's remarks: the deterministic
// ones, the model's gated ones and `no-baseline`, settled and ranked together. `reeval record`
// copies them into the history. Whatever happens here (no key, a model that fails, Ctrl-C), the run prints its facts and
// keeps its exit code; this only ever adds a line saying why some or all have no insights. A
// missing key is one short line naming it; `reeval analyze --insights` and `reeval doctor` give
// the whole credential message.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { missingAnalysisKey, resolveAnalysisModel } from '../analysis/model.ts'
import { renderSummary } from '../history/summary.ts'
import type { RunRecord } from '../history/types.ts'
import { clip } from '../text.ts'
import type { ResolvedConfig } from '../types.ts'
import { markPrinted } from '../ui/remarks.ts'
import type { RunInsights } from '../view/insights.ts'
import { INSIGHTS_FILE } from '../view/insights.ts'
import { suiteResult } from '../view/suite.ts'
import { classifyCache } from './classify.ts'
import { replaceInsights, writeInsights } from './files.ts'
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
  /**
   * The remarks-only insights the run already wrote there, when it raised remarks: the document
   * written in their place keeps the remarks.
   */
  remarks?: RunInsights | null
  /** `-v`: suggestions print too, so they're marked printed. */
  verbose?: boolean
  /** Ctrl-C: the calls in flight stop, no more start, and what finished is written. */
  signal?: AbortSignal
  stopSignal?: () => 'SIGINT' | 'SIGTERM'
  /** The line saying insights have started, once there's something to ask about. */
  onStart?: (text: string) => void
  onProgress?: (done: number, total: number) => void
  onUsage?: (call: CallUsage) => void
}): Promise<RunInsightsResult> {
  const { config, record, runDir } = options
  const evals = insightEvals(suiteResult(record)).length
  if (!evals) return { insights: null, lines: [] }
  const key = missingAnalysisKey(config)
  if (key) {
    return {
      insights: null,
      lines: [`insights skipped: set ${key} in .env.local, or analysis: { insights: false }`],
    }
  }
  let model: ReturnType<typeof resolveAnalysisModel>
  try {
    model = resolveAnalysisModel(config)
  } catch (error) {
    return { insights: null, lines: [`insights skipped: ${clip((error as Error).message, 240)}`] }
  }
  options.onStart?.(
    `insights: ${evals === 1 ? '1 eval' : `${evals} evals`} with ${model.name} (Ctrl-C skips the rest; --no-insights skips them all)`,
  )
  options.onProgress?.(0, evals)
  let insights: RunInsights
  try {
    const generated = await generateInsights({
      record,
      runDir,
      model,
      root: config.root,
      maxTokens: config.analysis.maxTokens,
      concurrency: RUN_CONCURRENCY,
      cache: classifyCache(config.root, config.history.dir),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.stopSignal ? { stopSignal: options.stopSignal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.onUsage ? { onUsage: options.onUsage } : {}),
    })
    const earlier = options.remarks?.remarks ?? []
    const remarks = await import('../remarks/index.ts')
      .then(({ withModelRemarks }) => withModelRemarks(config, record, generated, earlier))
      .then((all) => markPrinted(all, record.runId, options.verbose ?? false))
      .catch((error) => {
        process.stderr.write(
          `warning: no model remarks for this run: ${(error as Error).message}\n`,
        )
        return earlier
      })
    insights = { ...generated, remarks }
  } catch (error) {
    return {
      insights: null,
      lines: [
        `insights failed (${clip((error as Error).message, 200)}): reeval analyze ${record.runId} --insights to retry`,
      ],
    }
  }
  try {
    const file = join(runDir, INSIGHTS_FILE)
    if (options.remarks) await replaceInsights(file, insights)
    else await writeInsights(file, insights)
    await writeFile(join(runDir, 'summary.md'), renderSummary(record, { hint: false, insights }))
  } catch (error) {
    return {
      insights,
      lines: [`insights weren't written: ${clip((error as Error).message, 200)}`],
    }
  }
  return { insights, lines: [] }
}
