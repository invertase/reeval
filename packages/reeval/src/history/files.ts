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
import { dirname, join } from 'node:path'
import { fromCwd, RUN_ID, relativeFile, sha256 } from '../ids.ts'
import { factsHash } from '../insights/hash.ts'
import { BUILD_ID } from '../root.ts'
import type { QuestionInput } from '../types.ts'
import { runHeader } from '../view/header.ts'
import { fromModel, INSIGHTS_FILE, type RunInsights } from '../view/insights.ts'
import { NewerSchemaError, readableInsights, readableRecord } from '../view/record.ts'
import { suiteResult } from '../view/suite.ts'
import {
  ensureHistoryGitignore,
  historyGitignorePath,
  type IgnoredRecorded,
  ignoredRecordedFiles,
} from './ignore.ts'
import { type Finding, findingLines, findingSummary, scanText } from './secret-scan.ts'
import { renderSummary } from './summary.ts'
import type { ArtifactLevel, AttemptRecord, FileRef, HistoryEntry, RunRecord } from './types.ts'

export class HistoryError extends Error {
  override name = 'HistoryError'
}

/** A record from a newer reeval: skipped with a warning to upgrade, never "restore or delete it". */
export class NewerRecordError extends HistoryError {
  readonly reason: string
  constructor(error: NewerSchemaError) {
    super(error.message)
    this.reason = error.reason
  }
}

/** Where `reeval run` writes runs before they're recorded. Gitignored. */
export const scratchDir = (root: string) => join(root, '.reeval', 'runs')
const cacheFile = (root: string) => join(root, '.reeval', 'history-cache.json')
const TEXT_FILE = /\.(json|jsonl|md|patch|log|txt)$/

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

/**
 * A file another process is writing, renaming or removing right now: Windows refuses to open or
 * replace one that's open elsewhere (EPERM, EBUSY). It reads fine on a later try.
 */
const inFlux = (error: unknown) =>
  ['ENOENT', 'EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
const tmpName = () => `${process.pid}-${randomBytes(6).toString('hex')}`
export const encodeRecord = (record: RunRecord) =>
  Buffer.from(`${JSON.stringify(record, null, 2)}\n`)

export function parseRecord(bytes: Uint8Array, where: string): RunRecord {
  const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as RunRecord
  if (value?.kind !== 'reeval-run') throw new HistoryError(`${where} is not a reeval run record`)
  try {
    return readableRecord(value, where)
  } catch (error) {
    if (error instanceof NewerSchemaError) throw new NewerRecordError(error)
    throw error
  }
}

export async function readRecord(path: string): Promise<RunRecord> {
  return parseRecord(await readFile(path), path)
}

const warnedUnreadable = new Set<string>()

/**
 * Says once per process that a run-named file isn't a readable record, so a run lost to a bad
 * merge or a cut-short copy doesn't silently drop out of history, compare's base and queries.
 */
export function warnUnreadable(path: string, error: unknown): void {
  if (warnedUnreadable.has(path)) return
  warnedUnreadable.add(path)
  if (error instanceof NewerRecordError) {
    process.stderr.write(`warning: skipped ${fromCwd(path)}: ${error.reason}\n`)
    return
  }
  const why = error instanceof Error ? error.message : String(error)
  process.stderr.write(
    `warning: skipped ${fromCwd(path)}: not a readable reeval run record (${why}). Restore it from git, or delete it.\n`,
  )
}

/** A run's record file in a history or scratch folder. */
export const recordFile = (dir: string, runId: string) => join(dir, `${runId}.json`)
/** A run's artifact directory in a history or scratch folder. */
export const runDir = (dir: string, runId: string) => join(dir, runId)

/** The top-level `.json` names in `dir` (records land last and whole), sorted; null if it's missing. */
export async function recordNames(dir: string): Promise<string[] | null> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

/**
 * The newest `limit` records across `dirs`, by file name (= start time), oldest first. Files that
 * aren't readable records are skipped: these feed estimates, not results.
 */
export async function recentRecords(dirs: string[], limit: number): Promise<RunRecord[]> {
  const paths: string[] = []
  for (const dir of dirs) {
    const names = (await recordNames(dir).catch(() => null)) ?? []
    paths.push(...names.map((n) => join(dir, n)))
  }
  const recent = paths
    .sort((a, b) => (a.split('/').at(-1) ?? '').localeCompare(b.split('/').at(-1) ?? ''))
    .slice(-limit)
  const records: RunRecord[] = []
  for (const path of recent) {
    try {
      records.push(await readRecord(path))
    } catch {}
  }
  return records
}

type Cache = {
  /**
   * This build of reeval (`BUILD_ID`): another reeval, or a rebuild, drops entries derived by the old
   * code.
   */
  build: string
  files: Record<string, { size: number; mtimeMs: number; entry: HistoryEntry }>
}

const BUILD = BUILD_ID

async function readCache(root: string): Promise<Cache> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(root), 'utf8')) as Cache
    if (parsed.build === BUILD && parsed.files) return parsed
  } catch {}
  return { build: BUILD, files: {} }
}

/**
 * Every run in `dir`, sorted by file name (= start time). Derived from the folder listing on
 * every read; parsed records are cached in `.reeval/` by size and mtime, and never committed.
 */
export async function listRuns(
  root: string,
  dir: string,
  recorded: boolean,
): Promise<HistoryEntry[]> {
  const names = ((await recordNames(dir)) ?? []).filter((n) => RUN_ID.test(n.slice(0, -5)))
  if (names.length === 0) return []
  const cache = await readCache(root)
  let changed = false
  const entries: HistoryEntry[] = []
  for (const name of names) {
    const path = join(dir, name)
    const key = relativeFile(root, path)
    try {
      const info = await stat(path)
      const hit = cache.files[key]
      if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) {
        entries.push(hit.entry)
        continue
      }
      const entry = runHeader(await readRecord(path), recorded)
      cache.files[key] = { size: info.size, mtimeMs: info.mtimeMs, entry }
      entries.push(entry)
      changed = true
    } catch (error) {
      // A record landing as we list is left for the next read, not cached or warned about.
      if (inFlux(error)) continue
      if (!(error instanceof HistoryError) && !(error instanceof SyntaxError)) throw error
      warnUnreadable(path, error)
    }
  }
  if (changed) await writeCache(root, cache)
  return entries
}

/**
 * Best-effort: another reader (a studio serving parallel requests, a second `reeval`) may be
 * replacing the same file, which Windows refuses. The cache is only a speed-up.
 */
async function writeCache(root: string, cache: Cache): Promise<void> {
  const tmp = `${cacheFile(root)}.${tmpName()}`
  try {
    await mkdir(dirname(cacheFile(root)), { recursive: true })
    await writeFile(tmp, JSON.stringify(cache))
    await rename(tmp, cacheFile(root))
  } catch {
    await rm(tmp, { force: true }).catch(() => {})
  }
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

const failed = (x: { outcome: string }) => x.outcome === 'fail' || x.outcome === 'infra_error'

const keeps = (x: { outcome: string }, level: ArtifactLevel) =>
  level === 'all' || (level === 'failures' && failed(x))

const attemptRefs = (a: AttemptRecord): FileRef[] => [
  ...Object.values(a.files).flatMap((v) => (Array.isArray(v) ? v : v ? [v] : [])),
  ...a.checks.flatMap((c) => (c.log ? [c.log] : [])),
  ...(a.answers ?? []).flatMap((q) => (q.input ? [q.input] : [])),
]

export type RecordOptions = {
  root: string
  historyDir: string
  runId: string
  artifacts: ArtifactLevel
  allowIncomplete?: boolean
  /** Skip the last-chance secret scan, for false positives checked by hand. */
  skipSecretScan?: boolean
  /** summary.md ends with the hint to set an analysis model: none resolves. */
  hint: boolean
}

export type RecordResult = WrittenRun & {
  files: number
  bytes: number
  /** Where `worktree.patch` looked like it held a secret, so it was left out; else empty. */
  droppedPatch: string[]
  /** Files `git check-ignore` still matches after the history `.gitignore` was written. */
  ignored: IgnoredRecorded[]
}

/** Why a patch that looked like it held a secret isn't in the record. Starts with `SECRET_NOTE`. */
export const SECRET_NOTE = 'not kept: it looked like it held a secret'

/** Promotes a scratch run into the committed history folder. reeval never commits it. */
export async function recordRun(options: RecordOptions): Promise<RecordResult> {
  const { runId, artifacts: level } = options
  const source = scratchDir(options.root)
  let scratch: RunRecord
  try {
    scratch = await readRecord(join(source, `${runId}.json`))
  } catch (error) {
    if (isMissing(error)) throw new HistoryError(`No run ${runId} in .reeval/runs`)
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
  const keep = async (ref: FileRef) => {
    const bytes = await readFile(join(source, runId, ...ref.path.split('/')))
    if (sha256(bytes) !== ref.sha256) {
      throw new HistoryError(`${runId}/${ref.path} changed since the run wrote it`)
    }
    files.set(ref.path, bytes)
    return bytes
  }
  for (const e of record.evals) {
    // A pairwise input goes with its eval, and so do the screenshots it names: the sides it
    // compares passed, so their attempts don't keep them.
    const shown = new Set<string>()
    for (const q of e.answers ?? []) {
      if (!q.input) continue
      if (level === 'none' || !keeps(e, level)) {
        delete q.input
        continue
      }
      const input = JSON.parse(Buffer.from(await keep(q.input)).toString()) as QuestionInput
      for (const s of input.calls.flatMap((c) => c.screenshots ?? [])) {
        if ('path' in s && s.path) shown.add(s.path)
      }
    }
    // A cell or eval that failed with no failed attempt (a `minLift` gate) keeps every attempt's
    // files, as the only evidence of it.
    const whole = failed(e) && !e.attempts.some(failed)
    for (const a of e.attempts) {
      const cellFailed = e.attempts.some((b) => b.cell === a.cell && failed(b))
      const cell = e.cells.find((c) => c.key === a.cell)
      const all = whole || (cell !== undefined && failed(cell) && !cellFailed)
      if (level !== 'none' && (all || keeps(a, level))) {
        for (const ref of attemptRefs(a)) await keep(ref)
        continue
      }
      // Kept beside a failed attempt in its cell: `flaky_cells` tells the checks varying from the
      // agent by whether a failed attempt's diff matches a passing one's.
      const diff = level !== 'none' && cellFailed ? a.files.diff : undefined
      const screenshots = (a.files.artifacts ?? []).filter((r) => shown.has(r.path))
      a.files = {
        ...(diff ? { diff } : {}),
        ...(screenshots.length ? { artifacts: screenshots } : {}),
      }
      for (const ref of [...(diff ? [diff] : []), ...screenshots]) await keep(ref)
      for (const c of a.checks) delete c.log
      for (const q of a.answers ?? []) delete q.input
    }
  }
  const patch = record.git?.worktreePatch
  let droppedPatch: string[] = []
  if (patch && record.git && level !== 'none') {
    const bytes = await readFile(join(source, runId, patch.path))
    if (sha256(bytes) !== patch.sha256) {
      throw new HistoryError(`${runId}/${patch.path} changed since the run wrote it`)
    }
    // Kept byte-exact so it applies, so it can't be masked: a secret in it leaves it out instead.
    const findings = options.skipSecretScan ? [] : scanText(patch.path, bytes.toString())
    if (findings.length > 0) {
      droppedPatch = findingLines(patch.path, findings)
      record.git.worktreePatch = null
      record.git.worktreePatchNote = `${SECRET_NOTE} (${findingSummary(findings)})`
    } else {
      files.set(patch.path, bytes)
    }
  } else if (patch && record.git) {
    record.git.worktreePatch = null
    record.git.worktreePatchNote = "not kept: recorded with artifacts 'none'"
  }
  // The run's insights go with it whatever the artifact level: they're its answers, not evidence.
  // Remarks-only ones are restamped with the recorded record's facts, which can drop artifacts; a
  // model's keep their hash, so ones written for other facts are still left out with a note.
  const insightBytes = await readFile(join(source, runId, INSIGHTS_FILE)).catch(() => null)
  let insights: RunInsights | null = null
  if (insightBytes) {
    try {
      const read = readableInsights(JSON.parse(insightBytes.toString()), INSIGHTS_FILE)
      if (fromModel(read)) {
        insights = read
        files.set(INSIGHTS_FILE, insightBytes)
      } else {
        insights = { ...read, factsHash: factsHash(suiteResult(record)) }
        files.set(INSIGHTS_FILE, Buffer.from(`${JSON.stringify(insights, null, 2)}\n`))
      }
    } catch {}
  }
  if (level !== 'none') {
    const hint = options.hint && !(insights && fromModel(insights))
    files.set('summary.md', Buffer.from(renderSummary(record, { hint, insights })))
  }

  if (!options.skipSecretScan) {
    const scanned: Array<[string, Finding[]]> = [
      [`${runId}.json`, scanText(`${runId}.json`, encodeRecord(record).toString())],
      ...[...files]
        .filter(([path]) => TEXT_FILE.test(path))
        .map(([path, bytes]): [string, Finding[]] => [
          `${runId}/${path}`,
          scanText(path, Buffer.from(bytes).toString()),
        ]),
    ]
    const found = scanned.filter(([, findings]) => findings.length > 0)
    if (found.length > 0) {
      const lines = found.flatMap(([path, findings]) => findingLines(path, findings))
      throw new HistoryError(
        `Refusing to record ${runId}: ${found.length} file(s) look like they contain a secret:\n${lines.map((l) => `  ${l}`).join('\n')}\nCheck them, then pass --skip-secret-scan if these are false positives.`,
      )
    }
  }
  await ensureHistoryGitignore(options.historyDir)
  const dest = recordFile(options.historyDir, runId)
  try {
    const old = await readRecord(dest)
    if (old.status === 'interrupted' || old.status === 'budget') {
      await rm(dest, { force: true })
      await rm(runDir(options.historyDir, runId), { recursive: true, force: true })
    }
  } catch {}
  const written = await writeRun(options.historyDir, record, files)
  const bytes = [...files.values()].reduce((n, b) => n + b.length, encodeRecord(record).length)
  if (!written.created) return { ...written, files: files.size, bytes, droppedPatch, ignored: [] }
  const writtenPaths = [
    written.recordPath,
    historyGitignorePath(options.historyDir),
    ...[...files.keys()].map((path) =>
      join(written.artifactDir ?? options.historyDir, ...path.split('/')),
    ),
  ]
  const ignored = await ignoredRecordedFiles(options.root, writtenPaths)
  return { ...written, files: files.size, bytes, droppedPatch, ignored }
}
