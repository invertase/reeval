// `reeval analyze [run] --insights`: classifies each eval of a run and writes its insights with
// the analysis model, checked by the validator, into its `insights.json` create-only (the history
// folder's, or the scratch run's before it's recorded), then prints the run's blocks with them.
// It's what `reeval run` does at its end, for a run that has none. A document with stopped, failed
// or budget-skipped evals is finished instead: only those are asked about, and it's replaced whole,
// as are remarks-only insights. Either way the document's remarks are kept, and the model's gated
// remarks and `no-baseline` are added. The facts and the exit code don't depend on what the
// model wrote: a dropped sentence or remark is counted, never an error.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAnalysisModel } from '../analysis/model.ts'
import { allRuns, CommandError } from '../commands.ts'
import { UsageError } from '../errors.ts'
import { readRecord, scratchDir } from '../history/files.ts'
import { resolveRun } from '../history/views.ts'
import { fromCwd } from '../ids.ts'
import type { ResolvedConfig } from '../types.ts'
import { render } from '../ui/layout.ts'
import { markPrinted } from '../ui/remarks.ts'
import { fromModel } from '../view/insights.ts'
import { suiteResult } from '../view/suite.ts'
import { classifyCache } from './classify.ts'
import { readInsights, replaceInsights, runInsightsFile, writeInsights } from './files.ts'
import { generateInsights, unfinishedEvals } from './generate.ts'
import { factsHash } from './hash.ts'
import { insightsPromptVersion } from './schema.ts'

type Ctx = {
  config: ResolvedConfig
  flags: { json?: boolean; verbose?: boolean[] }
  out: (s: string) => void
  err: (s: string) => void
}

/** The flags `--insights` can't take: they shape a `reeval analyze` document, which it doesn't write. */
export const NOT_WITH_INSIGHTS = ['vs', 'eval', 'md', 'save', 'context', 'dry-run', 'no-cache']

export async function insightsCommand(ctx: Ctx, ref: string | undefined): Promise<number> {
  const { config } = ctx
  if (config.analysis.model === undefined) {
    throw new UsageError(
      `reeval analyze --insights needs analysis.model, and never uses the judge's model. Set analysis: { model: 'google/gemini-3.8-flash' } in ${config.file}.`,
    )
  }
  const entry = resolveRun(await allRuns(config), ref ?? 'latest')
  const file = runInsightsFile(config, entry)
  const existing = existsSync(file) ? await readInsights(file) : null
  // Remarks-only insights hold no model's words, so they're written over, not finished.
  const prior = existing && fromModel(existing) ? existing : null
  const unfinished = prior ? unfinishedEvals(prior).size : 0
  if (existsSync(file) && (!existing || (prior && !unfinished))) {
    throw new CommandError(
      `${fromCwd(file)} already exists, and insights are never rewritten. reeval show ${entry.runId} prints them; delete the file to write new ones.`,
    )
  }
  const model = resolveAnalysisModel(config)
  const dir = entry.recorded ? config.history.dir : scratchDir(config.root)
  const record = await readRecord(join(dir, `${entry.runId}.json`))
  if (prior) {
    const written = `${prior.model} (${prior.promptVersion})`
    const asking = `${model.name} (${insightsPromptVersion()})`
    const reason =
      prior.factsHash !== factsHash(suiteResult(record))
        ? "it was written for other facts than this run's"
        : written !== asking
          ? `it was written by ${written}, and this would ask ${asking}`
          : null
    if (reason) {
      throw new CommandError(
        `${fromCwd(file)} has ${unfinished === 1 ? 'an unfinished eval' : 'unfinished evals'}, but ${reason}: delete the file to write new ones.`,
      )
    }
  }
  ctx.err(
    prior
      ? `finishing insights for ${entry.runId} with ${model.name}: ${unfinished === 1 ? '1 eval' : `${unfinished} evals`} left…`
      : `writing insights for ${entry.runId} with ${model.name}…`,
  )
  const generated = await generateInsights({
    record,
    runDir: join(dir, entry.runId),
    model,
    root: config.root,
    maxTokens: config.analysis.maxTokens,
    cache: classifyCache(config.root, config.history.dir),
    ...(prior ? { prior } : {}),
  })
  const earlier = existing?.remarks ?? []
  const { withModelRemarks } = await import('../remarks/index.ts')
  // The run's own remarks stay as its output marked them; only new remarks are added, marked as
  // this prints them.
  const had = new Set(earlier.map((r) => r.id))
  const fresh = (await withModelRemarks(config, record, generated, earlier)).filter(
    (r) => !had.has(r.id),
  )
  const marked = new Set(
    markPrinted([...earlier, ...fresh], entry.runId, false)
      .filter((r) => r.printed && !had.has(r.id))
      .map((r) => r.id),
  )
  const remarks = [...earlier, ...fresh.map((r) => ({ ...r, printed: marked.has(r.id) }))]
  const insights = { ...generated, remarks }
  // replaceInsights refuses before its rename, so a refused document leaves the one there.
  if (existing) await replaceInsights(file, insights)
  else await writeInsights(file, insights)
  const { dropped, regenerated } = insights.validation
  ctx.err(
    `wrote ${fromCwd(file)}: ${insights.evals.length} evals, ${dropped} ${dropped === 1 ? 'sentence' : 'sentences'} removed by the checks${regenerated ? `, ${regenerated} asked for again` : ''}. Commit it with git.`,
  )
  if (ctx.flags.verbose?.length) {
    for (const d of insights.validation.drops ?? []) {
      ctx.err(`removed  ${d.slot}: "${d.text}"\n         ${d.reason}`)
    }
  }
  if (ctx.flags.json) ctx.out(JSON.stringify(insights, null, 2))
  else {
    const suite = suiteResult(record)
    ctx.out(render(suite, insights, { color: false, verbose: false, hint: false }).join('\n'))
  }
  return 0
}

/** Refuses the `reeval analyze` flags `--insights` doesn't take. */
export function checkInsightsFlags(flags: Record<string, unknown>) {
  const given = NOT_WITH_INSIGHTS.filter((f) => flags[f] !== undefined && flags[f] !== false)
  if (given.length) {
    throw new UsageError(
      `reeval analyze --insights takes a run, --json and -v only, not ${given.map((f) => `--${f}`).join(', ')}`,
    )
  }
}
