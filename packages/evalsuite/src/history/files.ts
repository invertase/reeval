import { randomBytes } from 'node:crypto'
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { RUN_ID, sha256 } from '../ids.ts'
import { countSecrets } from '../redact.ts'
import { renderSummary } from './summary.ts'
import {
  type ArtifactLevel,
  type EvalEntry,
  type FileRef,
  type HistoryEntry,
  type RunRecord,
  SCHEMA_VERSION,
} from './types.ts'

export class HistoryError extends Error {
  override name = 'HistoryError'
}

/** Where `es run` writes runs before they're recorded. Gitignored. */
export const scratchDir = (root: string) => join(root, '.es', 'runs')
const cacheFile = (root: string) => join(root, '.es', 'history-cache.json')
const TEXT_FILE = /\.(json|jsonl|md|patch|log|txt)$/

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const tmpName = () => `${process.pid}-${randomBytes(6).toString('hex')}`
export const encodeRecord = (record: RunRecord) =>
  Buffer.from(`${JSON.stringify(record, null, 2)}\n`)

export function parseRecord(bytes: Uint8Array, where: string): RunRecord {
  const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as RunRecord
  if (value?.kind !== 'es-run') throw new HistoryError(`${where} is not an ES run record`)
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new HistoryError(
      `${where} has schema ${String(value.schemaVersion)}; this ES reads ${SCHEMA_VERSION}`,
    )
  }
  return value
}

export async function readRecord(path: string): Promise<RunRecord> {
  return parseRecord(await readFile(path), path)
}

function entryOf(record: RunRecord, recorded: boolean): HistoryEntry {
  return {
    runId: record.runId,
    recorded,
    status: record.status,
    startedAt: record.startedAt,
    author: record.author,
    git: record.git
      ? { sha: record.git.sha, branch: record.git.branch, dirty: record.git.dirty }
      : null,
    runner: record.runner.kind,
    harness: record.config.harness,
    model: record.config.model,
    summary: record.summary,
    stack: {
      imageId: record.environment.image?.id ?? null,
      agentCli: record.environment.agentCli,
      agentModel: record.environment.harness.model,
      judgeModel: record.environment.judge.model,
      judgeServed: record.environment.judge.resolvedModels,
      judgeVersion: record.environment.judge.version,
      threshold: record.environment.judge.threshold,
      fingerprintScope: record.environment.fingerprintScope,
    },
    evals: record.evals.map((e) => ({ id: e.id, fingerprint: e.fingerprint, outcome: e.outcome })),
  }
}

type Cache = {
  version: 2
  files: Record<string, { size: number; mtimeMs: number; entry: HistoryEntry }>
}

async function readCache(root: string): Promise<Cache> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(root), 'utf8')) as Cache
    if (parsed.version === 2 && parsed.files) return parsed
  } catch {}
  return { version: 2, files: {} }
}

/**
 * Every run in `dir`, sorted by file name (= start time). Derived from the folder listing on
 * every read; parsed records are cached in `.es/` by size and mtime, and never committed.
 */
export async function listRuns(
  root: string,
  dir: string,
  recorded: boolean,
): Promise<HistoryEntry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  names = names.filter((n) => n.endsWith('.json') && RUN_ID.test(n.slice(0, -5))).sort()
  if (names.length === 0) return []
  const cache = await readCache(root)
  let changed = false
  const entries: HistoryEntry[] = []
  for (const name of names) {
    const path = join(dir, name)
    const key = relative(root, path)
    const info = await stat(path)
    const hit = cache.files[key]
    if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) {
      entries.push(hit.entry)
      continue
    }
    try {
      const entry = entryOf(await readRecord(path), recorded)
      cache.files[key] = { size: info.size, mtimeMs: info.mtimeMs, entry }
      entries.push(entry)
      changed = true
    } catch (error) {
      if (!(error instanceof HistoryError) && !(error instanceof SyntaxError)) throw error
    }
  }
  if (changed) {
    await mkdir(dirname(cacheFile(root)), { recursive: true })
    const tmp = `${cacheFile(root)}.${tmpName()}`
    await writeFile(tmp, JSON.stringify(cache))
    await rename(tmp, cacheFile(root))
  }
  return entries
}

export type WrittenRun = { recordPath: string; artifactDir: string | null; created: boolean }

/**
 * Writes `<dir>/<runId>/` (artifacts), then `<dir>/<runId>.json` (the record). The record lands
 * last and create-only, so a reader never sees a half-written run, and a run is never rewritten.
 */
export async function writeRun(
  dir: string,
  record: RunRecord,
  artifacts: Map<string, Uint8Array>,
): Promise<WrittenRun> {
  const recordPath = join(dir, `${record.runId}.json`)
  const artifactDir = artifacts.size > 0 ? join(dir, record.runId) : null
  const bytes = encodeRecord(record)
  let existing: Buffer | null = null
  try {
    existing = await readFile(recordPath)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  if (existing) {
    if (existing.equals(bytes)) return { recordPath, artifactDir, created: false }
    throw new HistoryError(
      `${record.runId} is already recorded with different content (another --artifacts level?). Recorded runs are never rewritten.`,
    )
  }
  await mkdir(dir, { recursive: true })
  // An artifact dir without a record is left over from an interrupted write.
  await rm(join(dir, record.runId), { recursive: true, force: true })
  if (artifactDir) {
    const staging = join(dir, `.tmp-${tmpName()}`)
    try {
      for (const [path, content] of artifacts) {
        const file = join(staging, ...path.split('/'))
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, content)
      }
      await rename(staging, artifactDir)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  const tmp = join(dir, `.tmp-${tmpName()}.json`)
  await writeFile(tmp, bytes)
  try {
    await link(tmp, recordPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new HistoryError(`${recordPath} was written by another process meanwhile`)
    }
    throw error
  } finally {
    await unlink(tmp).catch(() => {})
  }
  return { recordPath, artifactDir, created: true }
}

const keeps = (e: EvalEntry, level: ArtifactLevel) =>
  level === 'all' || (level === 'failures' && (e.outcome === 'fail' || e.outcome === 'infra_error'))

const refsOf = (e: EvalEntry): FileRef[] =>
  e.attempts.flatMap((a) => [
    ...Object.values(a.files),
    ...a.checks.flatMap((c) => (c.log ? [c.log] : [])),
  ])

export type RecordOptions = {
  root: string
  historyDir: string
  runId: string
  artifacts: ArtifactLevel
  allowIncomplete?: boolean
  /** Skip the last-chance secret scan, for false positives checked by hand. */
  skipSecretScan?: boolean
}

export type RecordResult = WrittenRun & { files: number; bytes: number }

/** Promotes a scratch run into the committed history folder. ES never commits it. */
export async function recordRun(options: RecordOptions): Promise<RecordResult> {
  const { runId, artifacts: level } = options
  const source = scratchDir(options.root)
  let scratch: RunRecord
  try {
    scratch = await readRecord(join(source, `${runId}.json`))
  } catch (error) {
    if (isMissing(error)) throw new HistoryError(`No run ${runId} in .es/runs`)
    throw error
  }
  if (scratch.status !== 'complete' && !options.allowIncomplete) {
    throw new HistoryError(
      `Run ${runId} was ${scratch.status}; pass --allow-incomplete to record it`,
    )
  }
  const record: RunRecord = structuredClone(scratch)
  record.artifacts = level
  const files = new Map<string, Uint8Array>()
  for (const e of record.evals) {
    if (level !== 'none' && keeps(e, level)) {
      for (const ref of refsOf(e)) {
        const bytes = await readFile(join(source, runId, ...ref.path.split('/')))
        if (sha256(bytes) !== ref.sha256) {
          throw new HistoryError(`${runId}/${ref.path} changed since the run wrote it`)
        }
        files.set(ref.path, bytes)
      }
      continue
    }
    for (const a of e.attempts) {
      a.files = {}
      for (const c of a.checks) delete c.log
    }
  }
  const patch = record.git?.worktreePatch
  if (patch && level !== 'none') {
    const bytes = await readFile(join(source, runId, patch.path))
    if (sha256(bytes) !== patch.sha256) {
      throw new HistoryError(`${runId}/${patch.path} changed since the run wrote it`)
    }
    files.set(patch.path, bytes)
  } else if (patch && record.git) {
    record.git.worktreePatch = null
    record.git.worktreePatchNote = "not kept: recorded with artifacts 'none'"
  }
  if (level !== 'none') files.set('summary.md', Buffer.from(renderSummary(record)))

  if (!options.skipSecretScan) {
    const flagged = [...files]
      .filter(
        ([path, bytes]) => TEXT_FILE.test(path) && countSecrets(Buffer.from(bytes).toString()) > 0,
      )
      .map(([path]) => `${runId}/${path}`)
    if (countSecrets(encodeRecord(record).toString()) > 0) flagged.unshift(`${runId}.json`)
    if (flagged.length > 0) {
      throw new HistoryError(
        `Refusing to record ${runId}: ${flagged.length} file(s) look like they contain a secret:\n${flagged.map((p) => `  ${p}`).join('\n')}\nCheck them, then pass --skip-secret-scan if these are false positives.`,
      )
    }
  }
  const written = await writeRun(options.historyDir, record, files)
  const bytes = [...files.values()].reduce((n, b) => n + b.length, encodeRecord(record).length)
  return { ...written, files: files.size, bytes }
}
