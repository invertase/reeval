// `reeval analyze [run] --insights`: classifies each eval of a recorded run and writes its
// insights with the analysis model, checked by the validator, into `<run>/insights.json`
// create-only, then prints the run's blocks with them. The facts and the exit code don't depend
// on what the model wrote: a dropped sentence is counted, never an error.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAnalysisModel } from '../analysis/model.ts'
import { allRuns, CommandError } from '../commands.ts'
import { UsageError } from '../errors.ts'
import { readRecord } from '../history/files.ts'
import { resolveRun } from '../history/views.ts'
import { fromCwd } from '../ids.ts'
import type { ResolvedConfig } from '../types.ts'
import { render } from '../ui/layout.ts'
import { suiteResult } from '../view/suite.ts'
import { insightsFile, writeInsights } from './files.ts'
import { generateInsights } from './generate.ts'

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
  const entry = resolveRun(await allRuns(config), ref ?? 'latest')
  if (!entry.recorded) {
    throw new CommandError(
      `${entry.runId} isn't recorded, so there's no history folder for its insights. Run reeval record ${entry.runId} first, then reeval analyze ${entry.runId} --insights.`,
    )
  }
  const file = insightsFile(config.history.dir, entry.runId)
  if (existsSync(file)) {
    throw new CommandError(
      `${fromCwd(file)} already exists, and insights are never rewritten. reeval show ${entry.runId} prints them; delete the file to write new ones.`,
    )
  }
  const model = resolveAnalysisModel(config)
  const record = await readRecord(join(config.history.dir, `${entry.runId}.json`))
  ctx.err(`writing insights for ${entry.runId} with ${model.name}…`)
  const insights = await generateInsights({
    record,
    runDir: join(config.history.dir, entry.runId),
    model,
    maxOutputTokens: config.analysis.maxOutputTokens,
  })
  await writeInsights(file, insights)
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
