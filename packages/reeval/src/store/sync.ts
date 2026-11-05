// Recording to a remote store: a run lands in the store's copy (`.reeval/store/<id>/history`) as
// in a history folder, is marked in `pending/`, and is uploaded from there. A run that didn't
// upload stays marked until `reeval sync` uploads it.
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { debugRoot } from '../debug/files.ts'
import { UsageError } from '../errors.ts'
import { filesUnder, recordFile, replaceable, runDir } from '../history/files.ts'
import type { RunDebug, RunRecord } from '../history/types.ts'
import { randomSuffix, sha256 } from '../ids.ts'
import type { HistoryStore, ResolvedHistory, S3StoreDescriptor, StoredRun } from '../types.ts'
import { S3_ENV_DEFAULTS, unsafePath } from './resolve.ts'
import { s3Settings, s3Store } from './s3.ts'

/** A run the store didn't take: the store or the network failed, or it holds another version. */
export class StoreError extends Error {
  override name = 'StoreError'
}

export type RemoteHistory = ResolvedHistory & {
  store: Exclude<ResolvedHistory['store'], { kind: 'local' }>
}

export const isRemote = (history: ResolvedHistory): history is RemoteHistory =>
  history.store.kind !== 'local'

const stores = new WeakMap<object, HistoryStore>()

/** The store `history` keeps runs in; `s3()`'s client is made on first use. */
export function storeOf(history: RemoteHistory): HistoryStore {
  const { descriptor } = history.store
  let store = stores.get(descriptor)
  if (!store) {
    store = s3Store(descriptor)
    stores.set(descriptor, store)
  }
  return store
}

/** Refuses a run that would record to `s3()` without its keys, before anything runs. */
export function storeCredentials(history: ResolvedHistory): void {
  if (history.store.kind === 's3') s3Settings(history.store.descriptor)
}

/** `.reeval/store/<id>/pending`: the runs recorded into the copy that haven't uploaded yet. */
export const pendingDir = (history: RemoteHistory) => join(dirname(history.dir), 'pending')

/** `.reeval/store/<id>/debug/<run>`: the debug data a pending run uploads with it. */
export const debugStaging = (history: RemoteHistory, runId: string) =>
  join(dirname(history.dir), 'debug', runId)

/**
 * How old a marker with no record in the copy must be before it's dropped. `record` marks a run
 * before writing it into the copy, so a younger one can be another process's recording.
 */
const ORPHAN_MARKER_MS = 10 * 60_000

/**
 * The runs marked for upload, and in `recording` the marked runs with no record in the copy yet.
 * A marker older than `ORPHAN_MARKER_MS` with no record (the recording stopped in between) is
 * dropped: there's nothing to upload.
 */
async function markers(history: RemoteHistory): Promise<{ ready: string[]; recording: string[] }> {
  const names = await readdir(pendingDir(history)).catch(() => [])
  const ready: string[] = []
  const recording: string[] = []
  for (const name of names.filter((n) => !n.startsWith('.')).sort()) {
    if (existsSync(recordFile(history.dir, name))) {
      ready.push(name)
      continue
    }
    const marked = await stat(join(pendingDir(history), name)).catch(() => null)
    if (marked && Date.now() - marked.mtimeMs < ORPHAN_MARKER_MS) recording.push(name)
    else {
      await unmarkPending(history, name)
      await rm(debugStaging(history, name), { recursive: true, force: true })
    }
  }
  return { ready, recording }
}

/** The runs marked for upload that are in the copy, ready to upload. */
export async function pendingRuns(history: RemoteHistory): Promise<string[]> {
  return (await markers(history)).ready
}

/**
 * Where a failed try is retried: a 5xx, or `fetch` failing to reach the store. A refusal, a
 * conflict or a bug fails at once. Node's `fetch` throws `TypeError: fetch failed`, with the
 * system error as its cause; Bun's, in the compiled binary, a `TypeError` with the system error's
 * `code` (`ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`) on it.
 */
export function transient(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null)?.statusCode
  if (typeof status === 'number') return status >= 500
  if (!(error instanceof TypeError)) return false
  const { code } = error as { code?: unknown }
  return error.message === 'fetch failed' || (typeof code === 'string' && /^E[A-Z]+$/.test(code))
}

/** Three tries, a second apart and then four, for a store or network that failed once. */
async function tries<T>(work: () => Promise<T>, waits = [1000, 4000]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await work()
    } catch (error) {
      if (i >= waits.length || !transient(error)) throw error
      await sleep(waits[i])
    }
  }
}

/**
 * Why a store call failed. A refused key names the variables `s3()` read it from: R2 answers an
 * unknown access key id with a bare `401 Unauthorized`, S3 and MinIO with a 403.
 */
const reason = (error: unknown, history: RemoteHistory) => {
  const e = error as { message?: string; code?: string; statusCode?: number; cause?: unknown }
  const cause = (e.cause as { code?: string; message?: string } | undefined)?.code
  const status = e.statusCode ? ` (${e.statusCode}${e.code ? ` ${e.code}` : ''})` : ''
  const keys =
    (e.statusCode === 401 || e.statusCode === 403) && history.store.kind === 's3'
      ? `: ${keyHint(history.store.descriptor)}`
      : ''
  return `${e.message ?? String(error)}${status}${cause ? ` (${cause})` : ''}${keys}`
}

const keyHint = (descriptor: S3StoreDescriptor) => {
  const id = descriptor.env?.accessKeyId ?? S3_ENV_DEFAULTS.accessKeyId
  const secret = descriptor.env?.secretAccessKey ?? S3_ENV_DEFAULTS.secretAccessKey
  return `check that ${id} and ${secret} hold a key with access to the bucket`
}

export type Uploaded = 'uploaded' | 'replaced' | 'already'
type Upload = { how: Uploaded; version: string }

/**
 * Uploads the copy's run `runId` to the store. A run the store already holds is fine when it's
 * the same bytes, and replaced when the copy's continues it (a resume, `--retry-errors`), as a
 * history folder's is; any other version is a StoreError, and so is a store that keeps failing.
 */
export async function uploadRun(history: RemoteHistory, runId: string): Promise<Upload> {
  const store = storeOf(history)
  const record = await readFile(recordFile(history.dir, runId))
  const run = { runId, record, files: new Map(await filesUnder(runDir(history.dir, runId))) }
  const debug = await stagedDebug(history, runId, record)
  try {
    for (const [path, bytes] of debug) {
      await tries(() => store.addFile(runId, `debug/${path}`, bytes))
    }
    return await tries(async () => {
      const created = await store.writeRun(run, {})
      if (created.ok) return { how: 'uploaded' as const, version: created.version }
      const there = await store.readRun(runId)
      if (!there) throw new StoreError(`${runId} went missing from ${store.name} meanwhile`)
      if (Buffer.from(there.record).equals(record)) {
        return { how: 'already' as const, version: there.version }
      }
      if (!replaceable(Buffer.from(there.record), `${store.name} ${runId}`, record)) {
        throw new StoreError(
          `${runId} is already in ${store.name} with different content. Recorded runs are never rewritten.`,
        )
      }
      const replaced = await store.writeRun(run, { replaces: there.version })
      if (!replaced.ok) throw new StoreError(`${runId} was written to ${store.name} meanwhile`)
      return { how: 'replaced' as const, version: replaced.version }
    })
  } catch (error) {
    if (error instanceof UsageError || error instanceof StoreError) throw error
    throw new StoreError(`couldn't upload ${runId} to ${store.name}: ${reason(error, history)}`)
  }
}

/** The debug files the record names, from where recording staged them, each checked. */
async function stagedDebug(history: RemoteHistory, runId: string, record: Buffer) {
  const { debug } = JSON.parse(record.toString()) as RunRecord
  const files: Array<[string, Uint8Array]> = []
  for (const ref of debug?.files ?? []) {
    const file = join(debugStaging(history, runId), ...ref.path.split('/'))
    const bytes = await readFile(file).catch(() => null)
    if (!bytes || sha256(bytes) !== ref.sha256) {
      throw new StoreError(
        `${runId}'s debug file ${ref.path} is ${bytes ? 'changed' : 'missing'} in ${debugStaging(history, runId)}, so it can't upload as recorded`,
      )
    }
    files.push([ref.path, bytes])
  }
  return files
}

/**
 * Marks `runId` for upload. It's marked before it's written into the copy, so a recording that
 * stops in between leaves it marked; true if it was marked already.
 */
export async function markPending(history: RemoteHistory, runId: string): Promise<boolean> {
  const marker = join(pendingDir(history), runId)
  if (existsSync(marker)) return true
  await mkdir(pendingDir(history), { recursive: true })
  await writeFile(marker, '')
  return false
}

export async function unmarkPending(history: RemoteHistory, runId: string): Promise<void> {
  await rm(join(pendingDir(history), runId), { force: true })
}

/** Uploads `runId` and unmarks it; a failure leaves it marked, for `reeval sync`. */
export async function uploadPending(history: RemoteHistory, runId: string): Promise<Uploaded> {
  const { how, version } = await uploadRun(history, runId)
  await savePulled(history, (state) => {
    state.versions[runId] = version
  })
  await unmarkPending(history, runId)
  await rm(debugStaging(history, runId), { recursive: true, force: true })
  return how
}

/** The line a run that didn't upload ends with, and in GitHub Actions its annotation. */
export function notUploaded(error: Error, pending: string): string {
  const message = `${error.message.replace(/\.$/, '')}. The run is kept in ${pending}; reeval sync uploads it.`
  if (process.env.GITHUB_ACTIONS === 'true') {
    // On stderr, so `--json` keeps stdout; the runner reads workflow commands from both.
    process.stderr.write(
      `::error title=reeval: run not uploaded::${message.replace(/\n/g, '%0A')}\n`,
    )
  }
  return message
}

/** What the copy holds: when it was last pulled, and each run's version. */
type Pulled = { at: string | null; versions: Record<string, string> }

const pulledFile = (history: RemoteHistory) => join(dirname(history.dir), 'pulled.json')

async function readPulled(history: RemoteHistory): Promise<Pulled | null> {
  const text = await readFile(pulledFile(history), 'utf8').catch(() => null)
  if (!text) return null
  try {
    return JSON.parse(text) as Pulled
  } catch {
    return null
  }
}

async function savePulled(history: RemoteHistory, change: (state: Pulled) => void) {
  const state = (await readPulled(history)) ?? { at: null, versions: {} }
  change(state)
  await mkdir(dirname(history.dir), { recursive: true })
  const tmp = `${pulledFile(history)}.${randomSuffix(6)}`
  await writeFile(tmp, `${JSON.stringify(state)}\n`)
  await rename(tmp, pulledFile(history))
}

/** Puts a run the store holds into the copy, its files first and its record last. */
async function writeCopy(history: RemoteHistory, run: StoredRun) {
  await mkdir(history.dir, { recursive: true })
  const staging = join(history.dir, `.tmp-${randomSuffix(8)}`)
  try {
    for (const [path, bytes] of run.files) {
      if (unsafePath(path)) {
        warn(
          `skipped ${path} in ${storeOf(history).name}'s ${run.runId}: it isn't a path under the run`,
        )
        continue
      }
      const file = join(staging, ...path.split('/'))
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, bytes)
    }
    await rm(runDir(history.dir, run.runId), { recursive: true, force: true })
    if (existsSync(staging)) await rename(staging, runDir(history.dir, run.runId))
    const tmp = join(history.dir, `.tmp-${randomSuffix(8)}.json`)
    await writeFile(tmp, run.record)
    await rename(tmp, recordFile(history.dir, run.runId))
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

const warn = (message: string) => process.stderr.write(`warning: ${message}\n`)

/**
 * The run's files that don't match the hash its record names for them. The record names its
 * files as `{ path, sha256 }` wherever they're attached; `debug`'s are under `.reeval/debug`.
 */
function mismatched(run: StoredRun): string[] {
  const named = new Map<string, string>()
  const walk = (value: unknown, top: boolean) => {
    if (Array.isArray(value)) for (const v of value) walk(v, false)
    else if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>
      if (typeof o.path === 'string' && typeof o.sha256 === 'string') named.set(o.path, o.sha256)
      for (const [key, v] of Object.entries(o)) if (!(top && key === 'debug')) walk(v, false)
    }
  }
  walk(JSON.parse(Buffer.from(run.record).toString()), true)
  return [...run.files]
    .filter(([path, bytes]) => named.has(path) && sha256(bytes) !== named.get(path))
    .map(([path]) => path)
}

/** Checks `history`'s store answers, without listing or pulling it; a StoreError when it doesn't. */
export async function checkStore(history: RemoteHistory): Promise<void> {
  const store = storeOf(history)
  try {
    await tries(() => store.check())
  } catch (error) {
    if (error instanceof UsageError) throw error
    throw new StoreError(`couldn't read ${store.name}: ${reason(error, history)}`)
  }
}

export type Pull = { pulled: number; cachedAt: string | null; unreachable?: string }

/**
 * Brings the copy up to date with the store, at most once a minute unless `force`: every run
 * whose version it hasn't seen, except one still waiting to upload from here. A store it can't
 * reach leaves the copy as it was, with `unreachable` saying why; with no copy yet, that's a
 * StoreError. A run whose files don't match the hashes its record names (read while it was being
 * replaced) is left for the next pull, with a warning.
 */
export async function pullStore(
  history: RemoteHistory,
  options: { force?: boolean; maxAgeMs?: number } = {},
): Promise<Pull> {
  const store = storeOf(history)
  const state = await readPulled(history)
  const fresh = state?.at && Date.now() - Date.parse(state.at) < (options.maxAgeMs ?? 60_000)
  if (fresh && !options.force) return { pulled: 0, cachedAt: state?.at ?? null }
  const seen = state?.versions ?? {}
  const { ready, recording } = await markers(history)
  const waiting = new Set([...ready, ...recording])
  let pulled = 0
  try {
    const runs = await tries(() => store.listRuns())
    for (const { runId, version } of runs) {
      if (waiting.has(runId)) continue
      if (seen[runId] === version && existsSync(recordFile(history.dir, runId))) continue
      const run = await tries(() => store.readRun(runId))
      if (!run) continue
      const changed = mismatched(run)
      if (changed.length) {
        warn(
          `skipped ${runId} from ${store.name}: ${changed.join(', ')} ${changed.length === 1 ? "doesn't" : "don't"} match the hash in its record, so the next pull reads it again`,
        )
        continue
      }
      await writeCopy(history, run)
      await savePulled(history, (s) => {
        s.versions[runId] = run.version
      })
      pulled++
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof StoreError) throw error
    if (!state?.at) throw new StoreError(`couldn't read ${store.name}: ${reason(error, history)}`)
    return { pulled, cachedAt: state.at, unreachable: reason(error, history) }
  }
  const at = new Date().toISOString()
  await savePulled(history, (s) => {
    s.at = at
  })
  return { pulled, cachedAt: at }
}

export type DebugPull = {
  /** What the record says was uploaded; null when the run was recorded without debug data. */
  debug: RunDebug | null
  downloaded: number
  bytes: number
  /** Files already in `.reeval/debug/<run>` with the bytes the record names. */
  present: number
}

/**
 * Downloads the debug data the copy's record of `runId` names into `.reeval/debug/<run>`, where
 * `-v`'s readers, `reeval report` and `debug.keep`'s pruning find a run's own. A pull never does:
 * only this, for one run asked for. Each file is checked against the record's hash.
 */
export async function pullDebug(
  history: RemoteHistory,
  root: string,
  runId: string,
): Promise<DebugPull> {
  const store = storeOf(history)
  const { debug } = JSON.parse(
    (await readFile(recordFile(history.dir, runId))).toString(),
  ) as RunRecord
  const result: DebugPull = { debug: debug ?? null, downloaded: 0, bytes: 0, present: 0 }
  const target = join(debugRoot(root), runId)
  for (const ref of debug?.files ?? []) {
    const parts = ref.path.split('/')
    if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\'))) {
      throw new StoreError(`${runId}'s record names a debug file outside its run: ${ref.path}`)
    }
    const file = join(target, ...parts)
    const local = await readFile(file).catch(() => null)
    if (local && sha256(local) === ref.sha256) {
      result.present++
      continue
    }
    let bytes: Uint8Array | null
    try {
      bytes = await tries(() => store.readFile(runId, `debug/${ref.path}`))
    } catch (error) {
      if (error instanceof UsageError) throw error
      throw new StoreError(
        `couldn't download ${runId}'s debug/${ref.path} from ${store.name}: ${reason(error, history)}`,
      )
    }
    if (!bytes) throw new StoreError(`${store.name} has no debug/${ref.path} for ${runId}`)
    if (sha256(bytes) !== ref.sha256) {
      throw new StoreError(
        `${runId}'s debug/${ref.path} in ${store.name} doesn't match the hash in its record`,
      )
    }
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomSuffix(6)}`
    await writeFile(tmp, bytes)
    await rename(tmp, file)
    result.downloaded++
    result.bytes += bytes.length
  }
  return result
}
