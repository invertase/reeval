import { runDir } from '../ids.ts'
import { buildIndex, deriveStore, INDEX_PATH, parseIndex, parseRun } from '../record/index-file.ts'
import type { IndexEntry, RunRecord } from '../record/types.ts'
import { countSecrets } from '../redact.ts'
import type { CommitReport, ResultsStore, StoreReader } from './types.ts'

export class PublishError extends Error {
  override name = 'PublishError'
}

export type PublishOptions = {
  allowDirty?: boolean
  allowIncomplete?: boolean
  /** Skip the last-chance secret scan. For false positives you've checked by hand. */
  skipSecretScan?: boolean
}

export type PublishResult = CommitReport & { runs: string[] }

const TEXT_FILE = /\.(json|jsonl|md|patch|log|txt)$/

async function readRun(store: StoreReader, runId: string): Promise<RunRecord> {
  const path = `${runDir(runId)}/run.json`
  const bytes = await store.get(path)
  if (!bytes) throw new PublishError(`Run ${runId} not found locally`)
  return parseRun(bytes, path)
}

/** Refusals that apply before anything is uploaded. Returns the run's files. */
async function collect(
  local: StoreReader,
  runId: string,
  options: PublishOptions,
): Promise<Map<string, Uint8Array>> {
  const run = await readRun(local, runId)
  if (run.status !== 'complete' && !options.allowIncomplete) {
    throw new PublishError(`Run ${runId} was ${run.status}; pass --allow-incomplete to publish it`)
  }
  if (run.git?.dirty && !options.allowDirty) {
    throw new PublishError(
      `Run ${runId} ran on a dirty working tree, so nobody can reproduce it from ${run.git.sha.slice(0, 12)}. Commit first, or pass --allow-dirty.`,
    )
  }
  const files = new Map<string, Uint8Array>()
  const flagged: string[] = []
  for (const path of await local.list(`${runDir(runId)}/`)) {
    const bytes = await local.get(path)
    if (!bytes) continue
    if (!options.skipSecretScan && TEXT_FILE.test(path)) {
      if (countSecrets(Buffer.from(bytes).toString('utf8')) > 0) flagged.push(path)
    }
    files.set(path, bytes)
  }
  if (flagged.length > 0) {
    throw new PublishError(
      `Refusing to publish ${runId}: ${flagged.length} file(s) look like they contain a secret:\n${flagged.map((p) => `  ${p}`).join('\n')}\nCheck them, then pass --skip-secret-scan if these are false positives.`,
    )
  }
  return files
}

/** Copies local runs to `target` in one commit, regenerating its index. */
export async function publishRuns(
  local: StoreReader,
  target: ResultsStore,
  runIds: string[],
  options: PublishOptions = {},
): Promise<PublishResult> {
  const files = new Map<string, Uint8Array>()
  for (const runId of runIds) {
    for (const [path, bytes] of await collect(local, runId, options)) files.set(path, bytes)
  }
  const label = runIds.length === 1 ? runIds[0] : `${runIds.length} runs`
  const report = await target.commit({
    files,
    derive: deriveStore,
    message: `es: publish ${label}`,
  })
  return { ...report, runs: runIds }
}

export type PullOptions = {
  /** Only these run ids (default: every run the remote has). */
  runs?: string[]
  /** Also copy transcripts, diffs, logs and judge inputs. */
  full?: boolean
}

const isLight = (path: string) =>
  path.endsWith('/run.json') || path.endsWith('/summary.md') || path.endsWith('/result.json')

/** The remote's index, rebuilt from its records when it's missing or from another schema. */
export async function remoteIndex(store: StoreReader): Promise<IndexEntry[]> {
  const index = parseIndex(await store.get(INDEX_PATH)) ?? (await buildIndex(store, null))
  return index.runs
}

/** Copies runs from `source` into the local store. Files already present are left alone. */
export async function pullRuns(
  source: ResultsStore,
  local: ResultsStore,
  options: PullOptions = {},
): Promise<{ runs: string[]; files: number }> {
  await source.refresh?.()
  const wanted = options.runs ? new Set(options.runs) : null
  const entries = (await remoteIndex(source)).filter((e) => !wanted || wanted.has(e.runId))
  if (wanted) {
    const missing = [...wanted].filter((id) => !entries.some((e) => e.runId === id))
    if (missing.length) throw new PublishError(`Not in the results store: ${missing.join(', ')}`)
  }
  const files = new Map<string, Uint8Array>()
  const pulled: string[] = []
  for (const entry of entries) {
    const dir = runDir(entry.runId)
    const have = new Set(await local.list(`${dir}/`))
    const paths = (await source.list(`${dir}/`)).filter(
      (p) => !have.has(p) && (options.full || isLight(p)),
    )
    if (paths.length === 0) continue
    for (const path of paths) {
      const bytes = await source.get(path)
      if (bytes) files.set(path, bytes)
    }
    pulled.push(entry.runId)
  }
  await local.commit({ files, derive: deriveStore, message: 'es: pull' })
  return { runs: pulled, files: files.size }
}
