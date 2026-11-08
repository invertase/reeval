import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
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
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ArchiveError, openArchive, writeArchive } from '../archive/index.ts'
import type { ArchiveManifest } from '../archive/types.ts'
import { debugArchiveFile, debugRoot } from '../debug/files.ts'
import { fromCwd, RUN_ID, relativeFile, sha256 } from '../ids.ts'
import { BUILD_ID } from '../root.ts'
import type { QuestionInput } from '../types.ts'
import { DEBUG_LOG, REQUESTS_FILE, TRACE_FILE } from '../view/debug.ts'
import { runHeader } from '../view/header.ts'
import { NewerSchemaError, readableRecord, readableRemarks } from '../view/record.ts'
import { REMARKS_FILE, type RunRemarks } from '../view/remarks.ts'
import {
  ensureHistoryGitattributes,
  ensureHistoryGitignore,
  historyGitattributesPath,
  historyGitignorePath,
  type IgnoredRecorded,
  ignoredRecordedFiles,
} from './ignore.ts'
import { type Finding, findingLines, findingSummary, scanText } from './secret-scan.ts'
import { renderSummary } from './summary.ts'
import type {
  ArtifactLevel,
  ArtifactRef,
  AttemptRecord,
  FileRef,
  HistoryEntry,
  RunDebug,
  RunRecord,
} from './types.ts'

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
 * `<dir>/.tmp-<runId>.claim`: whoever creates it owns `<dir>/<runId>/` and `<dir>/<runId>.json`
 * until it's removed. It holds `<pid>\n<host>\n<token>\n`, linked into place whole.
 */
const claimFile = (dir: string, runId: string) => join(dir, `.tmp-${runId}.claim`)

const busy = (runId: string, file: string) =>
  new HistoryError(
    `${runId} is being recorded by another process right now. Try again once it finishes; if no reeval is running, delete ${fromCwd(file)}.`,
  )

/** A claim whose process is gone on this host. Another host's can't be probed, so it holds. */
function claimGone(held: string): boolean {
  const [pidLine, host] = held.split('\n')
  const pid = Number(pidLine)
  if (!Number.isInteger(pid) || pid <= 0 || !host) return true
  if (host !== hostname()) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/**
 * Removes the stale claim `held`, and only it. Breakers of one claim take
 * `<claim>.<hash of held>.break` first, so only one at a time may unlink it; while `held` is in
 * place nobody else can remove or replace it, so reading it then unlinking it is safe.
 */
async function breakClaim(file: string, held: string, runId: string): Promise<void> {
  const lock = `${file}.${sha256(held).slice(0, 12)}.break`
  try {
    await writeFile(lock, '', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' || inFlux(error)) {
      throw busy(runId, file)
    }
    throw error
  }
  try {
    let now: string | null
    try {
      now = await readFile(file, 'utf8')
    } catch (error) {
      if (isMissing(error)) return
      if (inFlux(error)) throw busy(runId, file)
      throw error
    }
    if (now === held) await unlink(file)
  } finally {
    await unlink(lock).catch(() => {})
  }
}

/** Takes `runId`'s claim in `dir`, breaking one a dead process left; returns its release. */
async function claimRun(dir: string, runId: string): Promise<() => Promise<void>> {
  const file = claimFile(dir, runId)
  const body = `${process.pid}\n${hostname()}\n${randomBytes(6).toString('hex')}\n`
  const tmp = `${file}.${tmpName()}`
  await writeFile(tmp, body)
  try {
    for (let tries = 0; tries < 3; tries++) {
      try {
        await link(tmp, file)
        return async () => {
          if ((await readFile(file, 'utf8').catch(() => null)) === body) {
            await unlink(file).catch(() => {})
          }
        }
      } catch (error) {
        // Windows reserves a name another process is still deleting: EPERM, not EEXIST.
        if (!['EEXIST', 'EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          throw error
        }
      }
      let held: string
      try {
        held = await readFile(file, 'utf8')
      } catch (error) {
        if (isMissing(error)) continue
        if (inFlux(error)) throw busy(runId, file)
        throw error
      }
      if (!claimGone(held)) throw busy(runId, file)
      await breakClaim(file, held, runId)
    }
    throw busy(runId, file)
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

/**
 * A record its continuation replaces: the run stopped before it finished, or `next` ran one of
 * its infra errors again and keeps that error in the attempt's `retries`.
 */
export const replaceable = (bytes: Buffer, where: string, next: Buffer) => {
  try {
    const was = parseRecord(bytes, where)
    if (was.status === 'interrupted' || was.status === 'budget') return true
    const now = parseRecord(next, where)
    const retried = new Map(
      now.evals.flatMap((e) => e.attempts).map((a) => [a.key, a.retries ?? []] as const),
    )
    return was.evals
      .flatMap((e) => e.attempts)
      .some(
        (a) =>
          a.outcome === 'infra_error' &&
          retried
            .get(a.key)
            ?.some((r) => r.at === a.startedAt && r.error.message === a.error?.message),
      )
  } catch {
    return false
  }
}

const readIfThere = (path: string) =>
  readFile(path).catch((error) => {
    if (isMissing(error)) return null
    throw error
  })

/**
 * Claims the run, then writes `<dir>/<runId>/` (artifacts, and the snapshots `moves` brings in
 * by renaming), then `<dir>/<runId>.json` (the record). The record lands last and create-only, so a reader never sees a half-written run, and
 * a run is never rewritten, except an interrupted or budget-stopped one by its resumed run, and a
 * finished one by its `--retry-errors`.
 */
export async function writeRun(
  dir: string,
  record: RunRecord,
  artifacts: Map<string, Uint8Array>,
  moves: Map<string, string> = new Map(),
): Promise<WrittenRun> {
  const recordPath = recordFile(dir, record.runId)
  const artifactDir = artifacts.size > 0 ? runDir(dir, record.runId) : null
  const bytes = encodeRecord(record)
  // A landed record is only ever removed by a writer replacing an unfinished one, so an equal
  // one needs no claim.
  if ((await readIfThere(recordPath))?.equals(bytes)) {
    return { recordPath, artifactDir, created: false }
  }
  await mkdir(dir, { recursive: true })
  const release = await claimRun(dir, record.runId)
  try {
    return await writeClaimed(dir, record.runId, bytes, artifacts, moves)
  } finally {
    await release()
  }
}

/** What most likely makes a run's new record differ from the recorded one, for the refusal. */
function likelyChange(existing: Buffer, bytes: Buffer, runId: string): string {
  const parse = (b: Buffer) => {
    try {
      return JSON.parse(b.toString()) as RunRecord
    } catch {
      return null
    }
  }
  const [was, now] = [parse(existing), parse(bytes)]
  if (was && now && !isDeepStrictEqual(was.debug, now.debug)) {
    const { debug: _was, ...before } = was
    const { debug: _now, ...after } = now
    if (isDeepStrictEqual(before, after)) {
      return `its debug data differs: .reeval/debug/${runId} was pruned or changed since it was recorded, or history.debug is another level`
    }
  }
  return 'another --artifacts level?'
}

async function writeClaimed(
  dir: string,
  runId: string,
  bytes: Buffer,
  artifacts: Map<string, Uint8Array>,
  moves: Map<string, string>,
): Promise<WrittenRun> {
  const recordPath = recordFile(dir, runId)
  const artifactDir = artifacts.size > 0 ? runDir(dir, runId) : null
  const existing = await readIfThere(recordPath)
  if (existing?.equals(bytes)) return { recordPath, artifactDir, created: false }
  if (existing && !replaceable(existing, recordPath, bytes)) {
    throw new HistoryError(
      `${runId} is already recorded with different content (${likelyChange(existing, bytes, runId)}). Recorded runs are never rewritten.`,
    )
  }
  const staging = artifactDir ? join(dir, `.tmp-${tmpName()}`) : null
  try {
    if (staging) {
      for (const [path, content] of artifacts) {
        const file = join(staging, ...path.split('/'))
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, content)
      }
      for (const [path, source] of moves) {
        const target = join(staging, ...path.split('/'))
        await mkdir(dirname(target), { recursive: true })
        await rename(source, target)
      }
    }
    if (existing) {
      // A replaced record never goes missing: the new one is renamed over it, which is atomic,
      // and the claim keeps every other writer out meanwhile.
      const old = join(dir, `.tmp-${tmpName()}`)
      const tmp = join(dir, `.tmp-${tmpName()}.json`)
      await writeFile(tmp, bytes)
      let moved = false
      try {
        await rename(runDir(dir, runId), old).then(
          () => {
            moved = true
          },
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          },
        )
        if (staging && artifactDir) await rename(staging, artifactDir)
        await rename(tmp, recordPath)
      } catch (error) {
        // The old record stays, so its artifacts go back beside it.
        if (moved) {
          await rm(runDir(dir, runId), { recursive: true, force: true })
          await rename(old, runDir(dir, runId))
        }
        throw error
      } finally {
        await rm(tmp, { force: true })
      }
      await rm(old, { recursive: true, force: true })
      return { recordPath, artifactDir, created: true }
    }
    // An artifact dir without a record is left over from an interrupted write.
    await rm(runDir(dir, runId), { recursive: true, force: true })
    if (staging && artifactDir) await rename(staging, artifactDir)
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true })
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

/** Each capture's PNG, then the page facts beside it. */
const withPages = (refs: ArtifactRef[]): FileRef[] =>
  refs.flatMap((r) => (r.capture?.page ? [r, r.capture.page] : [r]))

const attemptRefs = (a: AttemptRecord): FileRef[] => [
  ...Object.values(a.files).flatMap((v) => (Array.isArray(v) ? withPages(v) : v ? [v] : [])),
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
  /**
   * The history folder is committed with git, so it gets its `.gitignore` and `.gitattributes`;
   * a remote store's copy isn't (default true).
   */
  committed?: boolean
  /** Upload the attempts' debug data too, staged in `staging` (a remote store's `history.debug`). */
  debug?: { level: RunDebug['level']; staging: string }
  /** Write the run's `<runId>.zip` beside its record too (`history.archive`). */
  archive?: boolean
  /** Write the run's debug data as `.reeval/debug/<runId>.zip` too (`history.debugArchive`). */
  debugArchive?: boolean
}

export type RecordResult = WrittenRun & {
  files: number
  bytes: number
  /** Where `worktree.patch` looked like it held a secret, so it was left out; else empty. */
  droppedPatch: string[]
  /** Files `git check-ignore` still matches after the history `.gitignore` was written. */
  ignored: IgnoredRecorded[]
  /** The debug data the record names, staged to upload with it. */
  debug?: RunDebug
  /** With `archive`, the run's zip, and whether this recording wrote it. */
  archive?: WrittenArchive
  /** With `debugArchive`, its debug data's zip; none when the run has no debug data. */
  debugArchive?: WrittenArchive
}

type WrittenArchive = { path: string; written: boolean }

/** `<dir>/<runId>.zip`: a recorded run, its record and every file recorded with it, as one zip. */
export const archiveFile = (dir: string, runId: string) => join(dir, `${runId}.zip`)

/** The whole of the run's `.reeval/debug/<runId>/` as its zip; none when it has no debug data. */
async function archiveDebug(root: string, runId: string): Promise<WrittenArchive | undefined> {
  const dir = join(debugRoot(root), runId)
  if ((await pathsUnder(dir)).length === 0) return undefined
  const release = await claimRun(debugRoot(root), runId)
  try {
    // A run's trace files can be large: each is hashed as a stream and read again only to zip it.
    const files = []
    for (const path of await pathsUnder(dir)) {
      const file = join(dir, ...path.split('/'))
      files.push({
        path: `${runId}/${path}`,
        sha256: await sha256File(file),
        data: () => readFile(file),
      })
    }
    if (files.length === 0) return undefined
    return await freshArchive(debugArchiveFile(root, runId), {
      contents: 'debug',
      runId,
      debugLevel: 'all',
      files,
    })
  } finally {
    await release()
  }
}

/** Every file under `dir`, by posix path, sorted. */
async function pathsUnder(dir: string, at = ''): Promise<string[]> {
  const entries = await readdir(join(dir, at), { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const entry of entries) {
    const path = at ? `${at}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await pathsUnder(dir, path)))
    else if (entry.isFile()) out.push(path)
  }
  return out.sort()
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** What a run's archive holds of `<runId>/`: everything but what's added after recording. */
const archived = (path: string) => !path.startsWith('analysis/')

/**
 * Writes an archive of `files`, unless the one at `path` already lists exactly them. A missing
 * zip, or one that isn't a readable archive, is written at revision 1; one that lists other
 * files is written again a revision on. One a newer reeval wrote is left as it is.
 */
async function freshArchive(
  path: string,
  options: Pick<Parameters<typeof writeArchive>[1], 'contents' | 'runId' | 'debugLevel'> & {
    files: Array<
      | { path: string; data: Uint8Array }
      | { path: string; sha256: string; data: () => Promise<Uint8Array> }
    >
  },
): Promise<WrittenArchive> {
  const wanted = new Map(
    options.files.map((f) => [f.path, 'sha256' in f ? f.sha256 : sha256(f.data)]),
  )
  let was: ArchiveManifest | null = null
  try {
    const archive = await openArchive(path)
    was = archive.manifest
    await archive.close()
  } catch (error) {
    if (error instanceof NewerSchemaError) return { path, written: false }
    if (!isMissing(error) && !(error instanceof ArchiveError)) throw error
  }
  const same =
    was?.files.length === wanted.size && was.files.every((f) => wanted.get(f.path) === f.sha256)
  if (was && same) return { path, written: false }
  await writeArchive(path, { ...options, revision: was ? was.revision + 1 : 1 })
  return { path, written: true }
}

/**
 * The run's archive beside its record: under the run's claim, of the record and files as they
 * are in the folder, so it never holds what this reeval would write but didn't. Nothing when the
 * record there isn't `record` any more: another recording replaced it meanwhile and archives its
 * own.
 */
async function archiveRun(
  dir: string,
  runId: string,
  record: Uint8Array,
): Promise<WrittenArchive | undefined> {
  const release = await claimRun(dir, runId)
  try {
    const landed = await readIfThere(recordFile(dir, runId))
    if (!landed?.equals(record)) return undefined
    const files = (await filesUnder(runDir(dir, runId))).filter(([path]) => archived(path))
    return await freshArchive(archiveFile(dir, runId), {
      contents: 'run',
      runId,
      files: [
        { path: `${runId}.json`, data: landed },
        ...files.map(([file, data]) => ({ path: `${runId}/${file}`, data })),
      ],
    })
  } finally {
    await release()
  }
}

/** Every file under `dir`, by posix path, with its bytes. */
export async function filesUnder(dir: string, at = ''): Promise<Array<[string, Uint8Array]>> {
  const entries = await readdir(join(dir, at), { withFileTypes: true }).catch(() => [])
  const out: Array<[string, Uint8Array]> = []
  for (const entry of entries) {
    const path = at ? `${at}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await filesUnder(dir, path)))
    else if (entry.isFile()) out.push([path, await readFile(join(dir, path))])
  }
  return out
}

const DEBUG_FILES: Record<RunDebug['level'], string[]> = {
  requests: [REQUESTS_FILE],
  all: [REQUESTS_FILE, DEBUG_LOG, TRACE_FILE],
}

/**
 * The run's debug data `level` names, from `.reeval/debug/<run>`, written to `staging` for the
 * upload; a file the secret scan finds something in is left out and named in `dropped`.
 */
async function stageDebug(
  root: string,
  runId: string,
  options: NonNullable<RecordOptions['debug']>,
): Promise<RunDebug | undefined> {
  const wanted = DEBUG_FILES[options.level]
  const debug: RunDebug = { level: options.level, files: [] }
  const dropped: NonNullable<RunDebug['dropped']> = []
  await rm(options.staging, { recursive: true, force: true })
  for (const [path, bytes] of await filesUnder(join(debugRoot(root), runId))) {
    if (!wanted.includes(path.slice(path.lastIndexOf('/') + 1))) continue
    // Always scanned, even with --skip-secret-scan: a finding drops the file, never the run.
    const findings = scanText(path, Buffer.from(bytes).toString())
    if (findings.length > 0) {
      dropped.push({ path, note: `${SECRET_NOTE} (${findingSummary(findings)})` })
      continue
    }
    const file = join(options.staging, ...path.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes)
    debug.files.push({ path, sha256: sha256(bytes), bytes: bytes.length })
  }
  if (dropped.length) debug.dropped = dropped
  return debug.files.length || dropped.length ? debug : undefined
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
      // Kept beside a failed attempt of its cell and case: `flaky_cells`, per case, tells the
      // checks varying from the agent by whether a failed attempt's diff matches a passing one's.
      const caseFailed = e.attempts.some((b) => b.cell === a.cell && b.case === a.case && failed(b))
      const diff = level !== 'none' && caseFailed ? a.files.diff : undefined
      const screenshots = (a.files.artifacts ?? []).filter((r) => shown.has(r.path))
      a.files = {
        ...(diff ? { diff } : {}),
        ...(screenshots.length ? { artifacts: screenshots } : {}),
      }
      for (const ref of [...(diff ? [diff] : []), ...withPages(screenshots)]) await keep(ref)
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
  // The run's remarks go with it whatever the artifact level: they're about the evals, not evidence.
  const remarkBytes = await readFile(join(source, runId, REMARKS_FILE)).catch(() => null)
  let remarks: RunRemarks | null = null
  if (remarkBytes) {
    try {
      remarks = readableRemarks(JSON.parse(remarkBytes.toString()), REMARKS_FILE)
      files.set(REMARKS_FILE, remarkBytes)
    } catch {}
  }
  if (level !== 'none') files.set('summary.md', Buffer.from(renderSummary(record, { remarks })))
  const debug = options.debug && (await stageDebug(options.root, runId, options.debug))
  if (debug) record.debug = debug

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
  const committed = options.committed ?? true
  if (committed) {
    await ensureHistoryGitignore(options.historyDir, options.archive ?? false)
    await ensureHistoryGitattributes(options.historyDir)
  }
  const written = await writeRun(options.historyDir, record, files)
  const zip =
    options.archive &&
    (await archiveRun(options.historyDir, runId, encodeRecord(record)).catch((error: unknown) => {
      const why = error instanceof Error ? error.message : String(error)
      throw new HistoryError(`Recorded ${runId}, but couldn't archive it: ${why}`, { cause: error })
    }))
  const debugArchive =
    options.debugArchive &&
    (await archiveDebug(options.root, runId).catch((error: unknown) => {
      const why = error instanceof Error ? error.message : String(error)
      throw new HistoryError(`Recorded ${runId}, but couldn't archive its debug data: ${why}`, {
        cause: error,
      })
    }))
  const archive = { ...(zip ? { archive: zip } : {}), ...(debugArchive ? { debugArchive } : {}) }
  const bytes = [...files.values()].reduce((n, b) => n + b.length, encodeRecord(record).length)
  if (!committed) {
    return {
      ...written,
      files: files.size,
      bytes,
      droppedPatch,
      ignored: [],
      ...(debug ? { debug } : {}),
      ...archive,
    }
  }
  const folderFiles = [
    historyGitignorePath(options.historyDir),
    historyGitattributesPath(options.historyDir),
  ]
  if (!written.created) {
    const ignored = await ignoredRecordedFiles(options.root, folderFiles)
    return { ...written, files: files.size, bytes, droppedPatch, ignored, ...archive }
  }
  const writtenPaths = [
    written.recordPath,
    ...folderFiles,
    ...[...files.keys()].map((path) =>
      join(written.artifactDir ?? options.historyDir, ...path.split('/')),
    ),
  ]
  const ignored = await ignoredRecordedFiles(options.root, writtenPaths)
  return { ...written, files: files.size, bytes, droppedPatch, ignored, ...archive }
}
