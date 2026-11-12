// A run's saved analyses as they leave this machine: with the run, in `reeval cloud push`'s and
// `reeval studio share`'s archive, and one at a time to `PUT /api/v1/runs/:runId/analysis`
// (`reeval analyze --save --push`). Each is checked first: at most `MAX_ANALYSIS_BYTES`, an
// analysis this reeval reads that fits `AnalysisDoc` (`parsedAnalysis`), and anchored on the run.
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CloudAuth } from '../cloud-run.ts'
import { CloudError, platformError, redirected, request } from '../cloud-run.ts'
import { CommandError } from '../commands.ts'
import { UsageError } from '../errors.ts'
import { fileInside } from '../studio/source.ts'
import type { AnalysisDoc } from '../view/analysis.ts'
import { parsedAnalysis } from '../view/analysis-schema.ts'
import { STUDIO_API_PREFIX } from '../view/api.ts'
import { savedAnalysisDir } from './files.ts'

/**
 * The largest analysis document that leaves this machine. One is the model's answer (at most
 * `analysis.maxOutputTokens`, 32,000 tokens by default, about 128 KB) plus the cited facts, each
 * clipped to 400 characters, so a real one is tens of KB; 1 MiB leaves room for any config.
 */
const MAX_ANALYSIS_BYTES = 2 ** 20

/** Why `bytes`, the analysis at `path`, can't go with run `runId`; undefined when it can. */
export function analysisProblem(
  bytes: Uint8Array,
  path: string,
  runId: string,
): string | undefined {
  if (bytes.length > MAX_ANALYSIS_BYTES) return tooLarge(path, bytes.length)
  const value = jsonOf(bytes)
  return value === undefined ? `${path} isn't JSON` : docProblem(value, path, runId)
}

const tooLarge = (path: string, size: number) =>
  `${path} is ${size} bytes, and an analysis may be at most ${MAX_ANALYSIS_BYTES} (1 MiB)`

function jsonOf(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

function docProblem(value: unknown, path: string, runId: string): string | undefined {
  let doc: AnalysisDoc
  try {
    doc = parsedAnalysis(value, path)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  if (doc.anchor !== runId) return `${path} is an analysis of run ${doc.anchor}, not ${runId}`
  return undefined
}

const isAnalysis = (value: unknown) =>
  (value as { kind?: unknown } | null)?.kind === 'reeval-analysis'

/**
 * Run `runId`'s saved analyses in `historyDir`, `<runId>/analysis/*.json`, as archive files;
 * exit 2, naming each, when any can't go with the run. A `.json` that isn't an analysis, or whose
 * real path leaves the run's folder, is left out with a warning, as every reader of saved
 * analyses leaves it out.
 */
export async function savedAnalysisFiles(
  historyDir: string,
  runId: string,
  warn: (line: string) => void,
): Promise<Array<{ path: string; data: Uint8Array }>> {
  const dir = savedAnalysisDir(historyDir, runId)
  const names = (await readdir(dir).catch((): string[] => []))
    .filter((n) => n.endsWith('.json'))
    .sort()
  const files: Array<{ path: string; data: Uint8Array }> = []
  const problems: string[] = []
  for (const name of names) {
    const path = `${runId}/analysis/${name}`
    const real = await fileInside(historyDir, [runId, 'analysis'], [name])
    if (!real) {
      const link = await lstat(join(dir, name)).catch(() => null)
      if (link?.isSymbolicLink()) {
        warn(`Leaving ${path} out of the push: it links outside the run's folder`)
      }
      continue
    }
    const { size } = await stat(real)
    if (size > MAX_ANALYSIS_BYTES) {
      problems.push(tooLarge(path, size))
      continue
    }
    const data = await readFile(real)
    const value = jsonOf(data)
    if (value !== undefined && !isAnalysis(value)) {
      warn(`Leaving ${path} out of the push: it isn't a reeval analysis`)
      continue
    }
    const problem = value === undefined ? `${path} isn't JSON` : docProblem(value, path, runId)
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
 * platform says it doesn't have (404, `run_not_found`) exits 2 with how to push it; any other 404
 * is a platform that takes no analysis uploads, and exits 3, as a failure does; any other refusal
 * exits 2.
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
  if (answer.status >= 300 && answer.status < 400) throw redirected('the analysis upload')
  if (
    answer.status === 404 &&
    (answer.body as { error?: unknown } | null)?.error === 'run_not_found'
  ) {
    throw new UsageError(
      `The cloud has no run ${runId}, so the analysis stays saved here only: reeval cloud push ${runId} uploads the run with its saved analyses.`,
    )
  }
  if (answer.status === 404) {
    throw new CloudError(
      `The cloud platform doesn't take analysis uploads (HTTP 404 from ${analysisUrl(base, runId).pathname}), so the analysis stays saved here only.`,
    )
  }
  if (!answer.ok) throw platformError(answer, what, auth)
}
