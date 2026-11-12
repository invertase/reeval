// A run's saved analyses as they leave this machine: with the run, in `reeval cloud push`'s and
// `reeval studio share`'s archive, and one at a time to `PUT /api/v1/runs/:runId/analysis`
// (`reeval analyze --save --push`). Each is checked first: at most `MAX_ANALYSIS_BYTES`, an
// analysis this reeval reads (`readableAnalysis`) that fits `AnalysisDoc`, and anchored on the run.
import { readdir, readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { CloudAuth } from '../cloud-run.ts'
import { CloudError, platformError, request } from '../cloud-run.ts'
import { CommandError } from '../commands.ts'
import { type Assert, dataProblem, type Same } from '../contract/shared.ts'
import { UsageError } from '../errors.ts'
import { fileInside } from '../studio/source.ts'
import type { AnalysisDoc } from '../view/analysis.ts'
import { STUDIO_API_PREFIX } from '../view/api.ts'
import { readableAnalysis } from '../view/record.ts'
import { savedAnalysisDir } from './files.ts'

/**
 * The largest analysis document that leaves this machine. One is the model's answer (at most
 * `analysis.maxOutputTokens`, 32,000 tokens by default, about 128 KB) plus the cited facts, each
 * clipped to 400 characters, so a real one is tens of KB; 1 MiB leaves room for any config.
 */
const MAX_ANALYSIS_BYTES = 2 ** 20

const confidence = z.enum(['high', 'medium', 'low'])
const role = z.enum(['finding', 'caveat', 'action'])
const attemptRefs = z.array(z.object({ attemptId: z.string(), path: z.string() }))
const claim = z.object({
  text: z.string(),
  cites: z.array(z.string()),
  confidence,
  quotes: z.array(z.string()).optional(),
  unverifiedNumbers: z.array(z.string()).optional(),
  evalId: z.string().optional(),
  role: role.optional(),
  attempts: attemptRefs.optional(),
})
const anomaly = z.object({
  text: z.string(),
  kind: z.enum(['reeval-bug', 'eval-design', 'judge', 'noise', 'other']),
  cites: z.array(z.string()),
  unverifiedNumbers: z.array(z.string()).optional(),
  evalId: z.string().optional(),
  role: role.optional(),
  attempts: attemptRefs.optional(),
})
const level = z.enum(['high', 'medium', 'low'])
const action = z.object({
  title: z.string(),
  target: z.string(),
  kind: z.enum(['skill', 'docs', 'eval', 'judge', 'reeval', 'harness']),
  change: z.string(),
  expectedEffect: z.string(),
  verify: z.string().nullable(),
  verifyProblem: z.string().optional(),
  impact: level,
  effort: level,
  cites: z.array(z.string()),
  evalId: z.string().optional(),
  role: role.optional(),
  attempts: attemptRefs.optional(),
})

/** `AnalysisDoc`. Keys it doesn't list pass: a newer reeval may have added them. */
const analysisDocSchema = z.object({
  kind: z.literal('reeval-analysis'),
  schemaVersion: z.literal(1),
  scope: z.object({
    kind: z.literal('run'),
    head: z.string(),
    base: z.string().nullable(),
    evals: z.string().nullable(),
  }),
  anchor: z.string(),
  inputs: z.object({
    records: z.array(z.object({ runId: z.string(), sha256: z.string() })),
    digestVersion: z.number(),
    digestHash: z.string(),
  }),
  promptVersion: z.string(),
  model: z.string(),
  resolvedModel: z.string().nullable(),
  route: z.enum(['direct', 'gateway', 'openrouter', 'vertex', 'fake']),
  usage: z.object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable() }),
  latencyMs: z.number(),
  createdAt: z.string(),
  author: z.string(),
  validation: z.object({
    citations: z.number(),
    invalid: z.array(z.string()),
    dropped: z.number(),
    commands: z.number(),
    invalidCommands: z.array(z.string()),
    unverifiedNumbers: z.number(),
  }),
  analysis: z.object({
    tldr: z.string(),
    whatHappened: z.array(claim),
    results: z.array(claim),
    why: z.array(claim),
    anomalies: z.array(anomaly),
    actions: z.array(action),
    confidence: z.object({ overall: confidence, why: z.string() }),
  }),
  attempts: z.record(
    z.string(),
    z.object({ runId: z.string(), evalSlug: z.string(), attempt: z.string() }),
  ),
  cited: z.record(z.string(), z.string()),
  error: z.string().optional(),
})

type _SameAsSchema = [
  Assert<Same<z.infer<typeof analysisDocSchema>, AnalysisDoc>>,
  Assert<Same<keyof z.infer<typeof analysisDocSchema>, keyof AnalysisDoc>>,
]

/** Why `bytes`, the analysis at `path`, can't go with run `runId`; undefined when it can. */
export function analysisProblem(
  bytes: Uint8Array,
  path: string,
  runId: string,
): string | undefined {
  if (bytes.length > MAX_ANALYSIS_BYTES) {
    return `${path} is ${bytes.length} bytes, and an analysis may be at most ${MAX_ANALYSIS_BYTES} (1 MiB)`
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return `${path} isn't JSON`
  }
  if ((value as { kind?: unknown } | null)?.kind !== 'reeval-analysis') {
    return `${path} isn't a reeval analysis (its kind isn't "reeval-analysis")`
  }
  let doc: AnalysisDoc
  try {
    doc = readableAnalysis(value as AnalysisDoc, path)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  const problem = dataProblem(analysisDocSchema, doc, path, () => [])
  if (problem) return problem
  if (doc.anchor !== runId) return `${path} is an analysis of run ${doc.anchor}, not ${runId}`
  return undefined
}

/**
 * Run `runId`'s saved analyses in `historyDir`, `<runId>/analysis/*.json`, as archive files;
 * exit 2, naming each, when any can't go with the run. A file whose real path leaves the run's
 * folder is left out, as every reader of saved analyses leaves it.
 */
export async function savedAnalysisFiles(
  historyDir: string,
  runId: string,
): Promise<Array<{ path: string; data: Uint8Array }>> {
  const names = (await readdir(savedAnalysisDir(historyDir, runId)).catch((): string[] => []))
    .filter((n) => n.endsWith('.json'))
    .sort()
  const files: Array<{ path: string; data: Uint8Array }> = []
  const problems: string[] = []
  for (const name of names) {
    const real = await fileInside(historyDir, [runId, 'analysis'], [name])
    if (!real) continue
    const path = `${runId}/analysis/${name}`
    const data = await readFile(real)
    const problem = analysisProblem(data, path, runId)
    if (problem) problems.push(problem)
    else files.push({ path, data })
  }
  if (problems.length) {
    throw new CommandError(
      `Refusing to push ${runId}: ${problems.length === 1 ? 'a saved analysis' : `${problems.length} saved analyses`} can't go with it:\n${problems.map((p) => `  ${p}`).join('\n')}\nFix or remove ${problems.length === 1 ? 'it' : 'them'}, then push again.`,
    )
  }
  return files
}

/** Where `PUT` sends run `runId`'s analysis on the platform at `base`. */
const analysisUrl = (base: URL, runId: string) =>
  new URL(`${STUDIO_API_PREFIX.slice(1)}/runs/${encodeURIComponent(runId)}/analysis`, base)

/**
 * Uploads `bytes`, a saved analysis of `runId`, to the platform's copy of the run. A run the
 * platform doesn't have exits 2 with how to push it; any other refusal exits 2 and a failure 3.
 */
export async function putAnalysis(
  base: URL,
  auth: CloudAuth,
  runId: string,
  bytes: Uint8Array,
): Promise<void> {
  const what = `upload the analysis of run ${runId}`
  const answer = await request(
    analysisUrl(base, runId),
    {
      method: 'PUT',
      what,
      // A redirect would resend the analysis, and the token, to wherever it points.
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(bytes),
    },
    auth.headers,
  )
  if (answer.status >= 300 && answer.status < 400) {
    throw new CloudError(
      `the cloud platform redirected the analysis upload elsewhere, and reeval doesn't send your sign-in on: check REEVAL_CLOUD_URL`,
    )
  }
  if (answer.status === 404) {
    throw new UsageError(
      `The cloud has no run ${runId}, so the analysis stays saved here only: reeval cloud push ${runId} uploads the run with its saved analyses.`,
    )
  }
  if (!answer.ok) throw platformError(answer, what, auth)
}
