import { randomBytes } from 'node:crypto'
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  type CommitChange,
  type CommitReport,
  ImmutableFileError,
  type ResultsStore,
  sameBytes,
} from './types.ts'

/** Local working directories that live next to the store but are never part of it. */
const PRIVATE = new Set(['staging', 'cache', 'attachments', 'results', '.tmp', '.lock'])
const RUN_DIR = /^runs\/\d{4}\/\d{2}\/[^/]+\//
const LOCK_STALE_MS = 60_000
const LOCK_WAIT_MS = 30_000

export type LocalStoreOptions = {
  /** Store directory (default `.es`), resolved against `root`. */
  dir?: string
  root?: string
}

export type LocalStore = ResultsStore & { readonly dir: string }

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const tmpName = () => `${process.pid}-${randomBytes(6).toString('hex')}`

export function localStore(options: LocalStoreOptions = {}): LocalStore {
  const dir = resolve(options.root ?? process.cwd(), options.dir ?? '.es')
  const abs = (path: string) => join(dir, ...path.split('/'))

  async function walk(rel: string, out: string[]) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(abs(rel), { withFileTypes: true })
    } catch (error) {
      if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return
      throw error
    }
    for (const entry of entries) {
      if (!rel && PRIVATE.has(entry.name)) continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path, out)
      else if (entry.isFile()) out.push(path)
    }
  }

  async function get(path: string): Promise<Uint8Array | null> {
    try {
      return await readFile(abs(path))
    } catch (error) {
      if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'EISDIR') return null
      throw error
    }
  }

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = join(dir, '.lock')
    await mkdir(dir, { recursive: true })
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        await (await open(lock, 'wx')).close()
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const age = await stat(lock).then(
          (s) => Date.now() - s.mtimeMs,
          () => 0,
        )
        if (age > LOCK_STALE_MS) await unlink(lock).catch(() => {})
        else if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}`)
        else await sleep(50)
      }
    }
    try {
      return await fn()
    } finally {
      await unlink(lock).catch(() => {})
    }
  }

  /** Create-only write: link() fails if the path exists, so a reader never sees partial bytes. */
  async function putFile(path: string, bytes: Uint8Array): Promise<'created' | 'exists'> {
    const existing = await get(path)
    if (existing) {
      if (sameBytes(existing, bytes)) return 'exists'
      throw new ImmutableFileError(path)
    }
    const target = abs(path)
    await mkdir(dirname(target), { recursive: true })
    const tmp = join(dir, '.tmp', tmpName())
    await mkdir(dirname(tmp), { recursive: true })
    await writeFile(tmp, bytes)
    try {
      await link(tmp, target)
      return 'created'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return putFile(path, bytes)
    } finally {
      await unlink(tmp).catch(() => {})
    }
  }

  /** A run directory that doesn't exist yet appears all at once, via rename. */
  async function putNewRun(runPath: string, files: [string, Uint8Array][]): Promise<boolean> {
    const target = abs(runPath)
    if (
      await stat(target).then(
        () => true,
        () => false,
      )
    )
      return false
    const staging = join(dir, '.tmp', tmpName())
    for (const [path, bytes] of files) {
      const file = join(staging, ...path.slice(runPath.length + 1).split('/'))
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, bytes)
    }
    await mkdir(dirname(target), { recursive: true })
    try {
      await rename(staging, target)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      await rm(staging, { recursive: true, force: true })
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return false
      throw error
    }
  }

  async function writeDerived(path: string, bytes: Uint8Array): Promise<boolean> {
    const existing = await get(path)
    if (existing && sameBytes(existing, bytes)) return false
    const tmp = join(dir, '.tmp', tmpName())
    await mkdir(dirname(tmp), { recursive: true })
    await writeFile(tmp, bytes)
    await mkdir(dirname(abs(path)), { recursive: true })
    await rename(tmp, abs(path))
    return true
  }

  const store: LocalStore = {
    dir,
    describe: () => ({ kind: 'local', dir }),
    async list(prefix) {
      const out: string[] = []
      await walk(prefix.replace(/\/+$/, ''), out)
      return out.sort()
    },
    get,
    commit(change: CommitChange): Promise<CommitReport> {
      return withLock(async () => {
        const created: string[] = []
        const existing: string[] = []
        const byRun = new Map<string, [string, Uint8Array][]>()
        const loose: [string, Uint8Array][] = []
        for (const entry of change.files) {
          const run = RUN_DIR.exec(entry[0])?.[0].slice(0, -1)
          if (run) byRun.set(run, [...(byRun.get(run) ?? []), entry])
          else loose.push(entry)
        }
        for (const [run, files] of byRun) {
          if (await putNewRun(run, files)) created.push(...files.map(([p]) => p))
          else loose.push(...files)
        }
        for (const [path, bytes] of loose) {
          ;((await putFile(path, bytes)) === 'created' ? created : existing).push(path)
        }
        let changed = created.length > 0
        for (const [path, bytes] of await change.derive(store)) {
          if (await writeDerived(path, bytes)) changed = true
        }
        return { created, existing, attempts: 1, changed }
      })
    },
  }
  return store
}
