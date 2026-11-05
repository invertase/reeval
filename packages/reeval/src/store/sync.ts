// Recording to a remote store: a run lands in the store's copy (`.reeval/store/<id>/history`) as
// in a history folder, is marked in `pending/`, and is uploaded from there. A run that didn't
// upload stays marked until `reeval sync` uploads it.
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { UsageError } from '../errors.ts'
import { recordFile, replaceable, runDir } from '../history/files.ts'
import type { HistoryStore, ResolvedHistory, S3StoreDescriptor } from '../types.ts'
import { S3_ENV_DEFAULTS } from './resolve.ts'
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

/**
 * The runs marked for upload. A marker whose run never reached the copy (the recording stopped in
 * between) is dropped: there's nothing to upload.
 */
export async function pendingRuns(history: RemoteHistory): Promise<string[]> {
  const names = await readdir(pendingDir(history)).catch(() => [])
  const runs: string[] = []
  for (const name of names.filter((n) => !n.startsWith('.')).sort()) {
    if (existsSync(recordFile(history.dir, name))) runs.push(name)
    else await unmarkPending(history, name)
  }
  return runs
}

async function filesUnder(dir: string, at = ''): Promise<Array<[string, Uint8Array]>> {
  const entries = await readdir(join(dir, at), { withFileTypes: true }).catch(() => [])
  const out: Array<[string, Uint8Array]> = []
  for (const entry of entries) {
    const path = at ? `${at}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await filesUnder(dir, path)))
    else if (entry.isFile()) out.push([path, await readFile(join(dir, path))])
  }
  return out
}

/** Where a failed try is retried: a network error or a 5xx, never a refusal or a conflict. */
function transient(error: unknown): boolean {
  if (error instanceof UsageError || error instanceof StoreError) return false
  const status = (error as { statusCode?: number }).statusCode
  return status === undefined || status >= 500
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

/**
 * Uploads the copy's run `runId` to the store. A run the store already holds is fine when it's
 * the same bytes, and replaced when the copy's continues it (a resume, `--retry-errors`), as a
 * history folder's is; any other version is a StoreError, and so is a store that keeps failing.
 */
export async function uploadRun(history: RemoteHistory, runId: string): Promise<Uploaded> {
  const store = storeOf(history)
  const record = await readFile(recordFile(history.dir, runId))
  const run = { runId, record, files: new Map(await filesUnder(runDir(history.dir, runId))) }
  try {
    return await tries(async () => {
      const created = await store.writeRun(run, {})
      if (created.ok) return 'uploaded'
      const there = await store.readRun(runId)
      if (!there) throw new StoreError(`${runId} went missing from ${store.name} meanwhile`)
      if (Buffer.from(there.record).equals(record)) return 'already'
      if (!replaceable(Buffer.from(there.record), `${store.name} ${runId}`, record)) {
        throw new StoreError(
          `${runId} is already in ${store.name} with different content. Recorded runs are never rewritten.`,
        )
      }
      const replaced = await store.writeRun(run, { replaces: there.version })
      if (!replaced.ok) throw new StoreError(`${runId} was written to ${store.name} meanwhile`)
      return 'replaced'
    })
  } catch (error) {
    if (error instanceof UsageError || error instanceof StoreError) throw error
    throw new StoreError(`couldn't upload ${runId} to ${store.name}: ${reason(error, history)}`)
  }
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
  const result = await uploadRun(history, runId)
  await unmarkPending(history, runId)
  return result
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
