// Recording to a remote store: a run lands in the store's copy (`.reeval/store/<id>/history`) as
// in a history folder, is marked in `pending/`, and is uploaded from there. A run that didn't
// upload stays marked until `reeval sync` uploads it.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { UsageError } from '../errors.ts'
import { recordFile, replaceable, runDir } from '../history/files.ts'
import type { HistoryStore, ResolvedHistory } from '../types.ts'
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

export async function pendingRuns(history: RemoteHistory): Promise<string[]> {
  const names = await readdir(pendingDir(history)).catch(() => [])
  return names.filter((n) => !n.startsWith('.')).sort()
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

const reason = (error: unknown) => {
  const e = error as { message?: string; code?: string; statusCode?: number; cause?: unknown }
  const cause = (e.cause as { code?: string; message?: string } | undefined)?.code
  const status = e.statusCode ? ` (${e.statusCode}${e.code ? ` ${e.code}` : ''})` : ''
  return `${e.message ?? String(error)}${status}${cause ? ` (${cause})` : ''}`
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
    throw new StoreError(`couldn't upload ${runId} to ${store.name}: ${reason(error)}`)
  }
}

export async function markPending(history: RemoteHistory, runId: string): Promise<void> {
  await mkdir(pendingDir(history), { recursive: true })
  await writeFile(join(pendingDir(history), runId), '')
}

/** Uploads `runId` and unmarks it; a failure leaves it marked, for `reeval sync`. */
export async function uploadPending(history: RemoteHistory, runId: string): Promise<Uploaded> {
  const result = await uploadRun(history, runId)
  await rm(join(pendingDir(history), runId), { force: true })
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
