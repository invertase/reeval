// `es analyze [run] [--vs base] [--eval filter]`: a digest of the run's facts, one structured call,
// validation, then the cache (always) and the run's history folder (with --save).
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commandSummary } from '../cli-spec.ts'
import { allRuns, CommandError, lines, reachability } from '../commands.ts'
import { UsageError } from '../errors.ts'
import { openHistoryDb } from '../history/db.ts'
import { parseRecord, scratchDir } from '../history/files.ts'
import { author } from '../history/provenance.ts'
import type { HistoryEntry } from '../history/types.ts'
import { pickBaseline, RefError, resolveRun } from '../history/views.ts'
import { fromCwd, sha256 } from '../ids.ts'
import { clip } from '../text.ts'
import type { ResolvedConfig } from '../types.ts'
import { ANALYSIS_PROMPT_VERSION, type AnalysisDoc } from '../view/analysis.ts'
import {
  buildDigest,
  type Digest,
  digestChars,
  digestHash,
  RULES,
  type RunInput,
} from './digest.ts'
import { readCached, saveAnalysis, writeCached } from './files.ts'
import { analysisModelName, callAnalysisModel, resolveAnalysisModel } from './model.ts'
import { renderMarkdown, renderText } from './render.ts'
import { SYSTEM_PROMPT } from './schema.ts'
import { validateAnalysis } from './validate.ts'

export type AnalyzeFlags = {
  json?: boolean
  md?: boolean
  vs?: string
  eval?: string
  save?: boolean
  context?: boolean
  'dry-run'?: boolean
  'no-cache'?: boolean
}

type Ctx = {
  config: ResolvedConfig
  flags: AnalyzeFlags
  out: (s: string) => void
  err: (s: string) => void
}

async function load(config: ResolvedConfig, entry: HistoryEntry): Promise<RunInput> {
  const dir = entry.recorded ? config.history.dir : scratchDir(config.root)
  const bytes = await readFile(join(dir, `${entry.runId}.json`))
  return { record: parseRecord(bytes, entry.runId), dir, bytes }
}

/** The model's input: the digest as JSON, after the project's own instructions. */
export const promptOf = (d: Digest) =>
  `${d.instructions ? `PROJECT INSTRUCTIONS: ${d.instructions}\n\n` : ''}DIGEST:\n${JSON.stringify(d)}`

/** `--context`: the same digest and rules, for the user's own coding agent. */
export function contextMarkdown(d: Digest, head: string, base: string | null): string {
  return [
    `# ES analysis context: ${head}${base ? ` vs ${base}` : ''}`,
    '',
    'Analyse this ES run for the engineer who wrote the evals. The digest below holds facts ES computed (F…), evidence excerpts (E…, transcript lines as L<n>) and the attempts table. Cite those ids for every claim, keep to the verdicts in the facts, and suggest at most 5 concrete actions, each verified with an es command from the CLI list.',
    '',
    '## How ES decided each verdict',
    '',
    ...RULES.map((r) => `- ${r}`),
    '',
    '## Instructions ES gives its own analysis model',
    '',
    SYSTEM_PROMPT,
    '',
    '## ES CLI (verify commands must be one of these)',
    '',
    ...commandSummary().map((c) => `- \`${c}\``),
    '',
    '## To dig further',
    '',
    '- `es query effort`, `es query factor_effects`, `es query skill_reads`, `es query flaky_cells`, `es query drift`',
    `- \`es query "SELECT line, tool, target FROM tool_calls WHERE attempt_key = '<key>'"\`: an attempt's tool calls`,
    "- `es show <run> --json`: the whole record; transcripts are under the run's artifact folder",
    '',
    '## Digest',
    '',
    '```json',
    JSON.stringify(d, null, 1),
    '```',
    '',
  ].join('\n')
}

function citedSummary(d: Digest, cites: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of cites) {
    const fact = d.facts.find((f) => f.id === c)
    const evidence = d.evidence.find((e) => e.id === c || c.startsWith(`${e.id}:`))
    const attempt = d.attempts[c.replace(/:check\d+$/, '')]
    if (fact) {
      const { id: _id, ...rest } = fact
      out[c] = clip(JSON.stringify(rest), 400)
    } else if (evidence) {
      const line = /:L(\d+)$/.exec(c)
      out[c] = line
        ? clip(evidence.lines.find((l) => l.startsWith(`L${line[1]} `)) ?? evidence.ref, 400)
        : `${evidence.ref}: ${evidence.why}`
    } else if (attempt) {
      out[c] =
        `${attempt.runId} · ${attempt.attempt} · ${attempt.outcome} · ${attempt.tools} tool calls`
    }
  }
  return out
}

export async function analyzeCommand(ctx: Ctx, args: string[]): Promise<number> {
  const { config, flags } = ctx
  if (flags.json && flags.md) throw new UsageError('es analyze takes --json or --md, not both')
  if (flags.context && flags.save) {
    throw new UsageError('es analyze --context makes no analysis to save; drop --save')
  }
  const entries = await allRuns(config)
  let evalFilter = flags.eval ?? null
  let head: HistoryEntry
  try {
    head = resolveRun(entries, args[0] ?? 'latest')
  } catch (error) {
    const needle = args[0]?.toLowerCase()
    const latest = entries.at(-1)
    if (
      !(error instanceof RefError) ||
      !needle ||
      !latest?.evals.some((e) => e.id.toLowerCase().includes(needle))
    ) {
      throw error
    }
    evalFilter ??= args[0] as string
    head = latest
  }
  let base: HistoryEntry | null
  if (flags.vs) base = resolveRun(entries, flags.vs)
  else {
    const reach = await reachability(config.root)
    const from = head.git && (!reach || reach.has(head.git.sha)) ? head.git.sha : 'HEAD'
    const ancestry = await lines(config.root, ['rev-list', '--max-count=5000', from])
    base = pickBaseline(
      entries.filter((e) => e.recorded && e.runId !== head.runId),
      head,
      ancestry,
    )
  }
  if (base?.runId === head.runId) throw new UsageError('es analyze --vs names the run itself')
  if (flags.save && !head.recorded) {
    throw new CommandError(
      `${head.runId} isn't recorded, so there's no history folder to save into. Run es record ${head.runId} first, then es analyze ${head.runId} --save.`,
    )
  }
  // Fail on a missing model or key before any work, unless no call is coming.
  const model = flags.context || flags['dry-run'] ? null : resolveAnalysisModel(config)

  const headRun = await load(config, head)
  const baseRun = base ? await load(config, base) : null
  const db = await openHistoryDb(config.root, config.history.dir)
  let digest: Digest
  let tables: string[]
  try {
    digest = await buildDigest({
      head: headRun,
      base: baseRun,
      evalFilter,
      db,
      maxChars: config.analysis.maxInputTokens * 4,
      ...(config.analysis.instructions ? { instructions: config.analysis.instructions } : {}),
    })
    tables = db.schema().map((o) => o.name)
  } finally {
    db.close()
  }
  if (evalFilter && digest.setup.evals.length === 0) {
    throw new UsageError(`No eval in ${head.runId} matches "${evalFilter}"`)
  }
  if (flags.context) {
    ctx.out(contextMarkdown(digest, head.runId, base?.runId ?? null))
    return 0
  }

  const modelName = (() => {
    try {
      const m = analysisModelName(config)
      return typeof m === 'string' ? m : 'fake'
    } catch {
      return 'none'
    }
  })()
  const hash = digestHash(digest)
  const scope = {
    kind: 'run' as const,
    head: head.runId,
    base: base?.runId ?? null,
    evals: evalFilter,
  }
  const key = sha256(
    JSON.stringify({ scope, hash, prompt: ANALYSIS_PROMPT_VERSION, model: modelName }),
  ).replace(/^sha256:/, '')
  const cached = flags['no-cache'] ? null : await readCached(config.root, key)
  if (flags['dry-run']) {
    const chars = digestChars(digest)
    ctx.out(
      [
        `digest ${head.runId}${base ? ` vs ${base.runId}` : ''}: ${digest.facts.length} facts, ${digest.evidence.length} evidence items${digest.dropped.length ? ` (${digest.dropped.length} dropped to fit)` : ''}, ${Object.keys(digest.attempts).length} attempts`,
        `size ${chars} characters ≈ ${Math.ceil(chars / 4)} tokens (cap ${config.analysis.maxInputTokens} in, ${config.analysis.maxOutputTokens} out)`,
        `model ${modelName} · ${ANALYSIS_PROMPT_VERSION} · cache ${cached ? 'hit' : 'miss'} (.es/analysis/${key}.json)`,
      ].join('\n'),
    )
    return 0
  }

  let doc: AnalysisDoc
  if (cached) {
    doc = cached
    ctx.err(
      `cached analysis from ${cached.createdAt} (.es/analysis/${key}.json); --no-cache calls the model again`,
    )
  } else {
    const resolved = model ?? resolveAnalysisModel(config)
    ctx.err(`analysing ${head.runId}${base ? ` vs ${base.runId}` : ''} with ${resolved.name}…`)
    const answer = await callAnalysisModel(
      resolved,
      digest,
      promptOf(digest),
      config.analysis.maxOutputTokens,
    )
    const evals = headRun.record.evals.map((e) => ({
      file: e.file,
      name: [...e.group, e.name].join(' '),
      tags: e.tags,
      cells: e.cells.map((c) => c.key),
    }))
    const { body, validation } = validateAnalysis(answer.output, digest, tables, evals)
    const cites = [
      ...body.whatHappened,
      ...body.results,
      ...body.why,
      ...body.anomalies,
      ...body.actions,
    ].flatMap((x) => x.cites)
    doc = {
      kind: 'es-analysis',
      schemaVersion: 1,
      scope,
      anchor: head.runId,
      inputs: {
        records: [baseRun, headRun].flatMap((r) =>
          r ? [{ runId: r.record.runId, sha256: sha256(r.bytes) }] : [],
        ),
        digestVersion: digest.digestVersion,
        digestHash: hash,
      },
      promptVersion: ANALYSIS_PROMPT_VERSION,
      model: resolved.name,
      resolvedModel: answer.resolvedModel,
      route: resolved.route,
      usage: answer.usage,
      latencyMs: answer.latencyMs,
      createdAt: new Date().toISOString(),
      author: await author(config.root),
      validation,
      analysis: body,
      attempts: Object.fromEntries(
        Object.entries(digest.attempts).map(([id, a]) => [
          id,
          { runId: a.runId, evalSlug: a.evalSlug, attempt: a.attempt },
        ]),
      ),
      cited: citedSummary(digest, [...new Set(cites)]),
    }
    await writeCached(config.root, key, doc)
  }
  if (flags.save) {
    const saved = await saveAnalysis(config.history.dir, doc, key, renderMarkdown(doc))
    ctx.err(`saved ${saved.map((p) => fromCwd(p)).join(' and ')}. Commit them with git.`)
  }
  ctx.out(
    flags.json ? JSON.stringify(doc, null, 2) : flags.md ? renderMarkdown(doc) : renderText(doc),
  )
  return 0
}
