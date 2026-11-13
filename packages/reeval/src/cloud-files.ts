// A cloud run's files, downloaded from the platform into this project as a run here would have
// left them: `.reeval/runs`, `.reeval/debug` and, for a recorded run, the history folder, where
// `reeval show`, `compare`, `query` and the studio read a run of this machine's. The platform
// serves them as one gzip tar of paths from the project root, which may leave the snapshots, the
// debug data or the recorded copy out.
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { gunzip } from 'node:zlib'
import { readTar } from '@reeval/sandbox-docker'
import { type CloudAuth, CloudError, platformMessage } from './cloud-run.ts'
import { UsageError } from './errors.ts'
import { displayUrl } from './events.ts'
import { NewerRecordError, parseRecord } from './history/files.ts'
import { ensureHistoryGitattributes, ensureHistoryGitignore } from './history/ignore.ts'
import { fromCwd, RUN_ID, relativeFile } from './ids.ts'
import { plural } from './text.ts'
import type { ResolvedHistory } from './types.ts'
import { formatBytes } from './view/debug.ts'
import { NewerSchemaError, readableCloudOrigin } from './view/record.ts'

/** The most a run's files may unpack to. */
const MAX_BYTES = 2 * 1024 ** 3

type Area = 'runs' | 'debug' | 'history'

/** What each area holds whole beside a run's folder: a record (`.json`) or a zip. */
const WHOLE: Record<Area, string[]> = {
  runs: ['.json'],
  debug: ['.zip'],
  history: ['.json', '.zip'],
}

type File = {
  area: Area
  runId: string
  path: string
  data: Buffer
  record: boolean
  /**
   * Whether it may be a link: inside an attempt's workspace snapshot, which keeps the workspace's
   * own links, in `.reeval/runs` or in the run's folder in the history. Every other file is one
   * that reeval reads as written, never through a link.
   */
  linkable: boolean
  /** A link's target. */
  link?: string
}

/** The platform's URL for the files of the run whose event stream is at `events`, if it's one. */
export function cloudRunOf(events: string, base: URL): { runId: string; files: URL } | null {
  const url = URL.parse(events)
  if (!url) return null
  const origin = (u: URL) => `${u.protocol.replace(/^ws/, 'http')}//${u.host}`
  if (origin(url) !== origin(base)) return null
  const at = `${base.pathname}api/runs/`
  if (!url.pathname.startsWith(at)) return null
  const id = /^([^/]+)\/events$/.exec(url.pathname.slice(at.length))?.[1]
  if (!id) return null
  let runId: string
  try {
    runId = decodeURIComponent(id)
  } catch {
    return null
  }
  return {
    runId,
    files: new URL(`api/runs/${encodeURIComponent(runId)}/artifacts/files.tar.gz`, base),
  }
}

/**
 * `download` once a cloud run has ended with `code`. Its failure decides the exit code, so its
 * message also gives the run's own.
 */
export async function downloadAfter(
  code: number,
  cloudRunId: string,
  download: () => Promise<string[]>,
): Promise<string[]> {
  try {
    return await download()
  } catch (error) {
    if (error instanceof Error) {
      error.message += ` (cloud run ${cloudRunId} itself exited with code ${code})`
    }
    throw error
  }
}

/**
 * Where an archive path lands: `outside` when it's outside `.reeval/runs`, `.reeval/debug` and the
 * history folder (`history`, its path from the project root, or null when it's outside it),
 * `other` for something in them that isn't a run's. The longer of the two prefixes wins, so a
 * history folder inside `.reeval/runs` holds its runs, and one at the project root or `.reeval`
 * leaves `.reeval/runs` and `.reeval/debug` theirs. A history folder at the project root holds
 * only runs, so anything else there is outside.
 */
function placed(
  path: string,
  history: string[] | null,
): Omit<File, 'data' | 'link'> | 'outside' | 'other' {
  const parts = path.split('/')
  let area: Area
  let rest: string[]
  const inHistory = history?.every((p, i) => parts[i] === p)
  if (history && inHistory && history.length >= 2) {
    area = 'history'
    rest = parts.slice(history.length)
  } else if (parts[0] === '.reeval' && (parts[1] === 'runs' || parts[1] === 'debug')) {
    area = parts[1]
    rest = parts.slice(2)
  } else if (history && inHistory) {
    area = 'history'
    rest = parts.slice(history.length)
  } else return 'outside'
  const [name, ...inner] = rest
  if (!name) return 'outside'
  const ext = inner.length ? undefined : WHOLE[area].find((e) => name.endsWith(e))
  const runId = ext ? name.slice(0, -ext.length) : name
  if (!RUN_ID.test(runId) || (!inner.length && !ext)) {
    return area === 'history' && !history?.length ? 'outside' : 'other'
  }
  const at = inner.indexOf('snapshots', 1)
  const linkable = area !== 'debug' && at > 0 && inner.length > at + 2
  return { area, runId, path, record: ext === '.json', linkable }
}

async function fetchArchive(url: URL, what: string, auth: CloudAuth): Promise<Buffer | null> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: { accept: 'application/gzip', ...auth.headers },
      signal: AbortSignal.timeout(10 * 60_000),
    })
  } catch (error) {
    const reason = error instanceof Error ? (error.cause ?? error).toString() : String(error)
    throw new CloudError(
      `couldn't download ${what}: ${displayUrl(url.href)} didn't answer (${reason})`,
    )
  }
  if (res.status === 404) return null
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {}
    const hint =
      (res.status === 401 || res.status === 403) && auth.refused ? ` (${auth.refused})` : ''
    const why = `${platformMessage(body) ?? `HTTP ${res.status}`}${hint}`
    if (res.status >= 500 || [408, 425, 429].includes(res.status)) {
      throw new CloudError(`couldn't download ${what}: ${why}`)
    }
    throw new UsageError(`the cloud platform refused to send ${what}: ${why}`)
  }
  if (Number(res.headers.get('content-length')) > MAX_BYTES) {
    throw new CloudError(`${what} are more than 2 GB: not downloading them`)
  }
  try {
    return Buffer.from(await res.arrayBuffer())
  } catch (error) {
    throw new CloudError(`couldn't download ${what}: ${(error as Error).message}`)
  }
}

/**
 * Whether `f` is free to write, there already, there with other content, or behind a parent that
 * isn't a directory (a link or a file), which nothing is written through.
 */
async function stateOf(
  root: string,
  f: File,
): Promise<'free' | 'same' | 'other' | { blocked: string }> {
  const parts = f.path.split('/')
  for (let i = 1; i < parts.length; i++) {
    const info = await lstat(join(root, ...parts.slice(0, i))).catch(() => null)
    if (!info) return 'free'
    if (!info.isDirectory()) return { blocked: parts.slice(0, i).join('/') }
  }
  const file = join(root, ...parts)
  const info = await lstat(file).catch(() => null)
  if (!info) return 'free'
  if (f.link !== undefined) {
    return info.isSymbolicLink() && (await readlink(file)) === f.link ? 'same' : 'other'
  }
  if (!info.isFile()) return 'other'
  return (await readFile(file)).equals(f.data) ? 'same' : 'other'
}

/** A path as this filesystem tells it apart: macOS's and Windows' fold case and normalize. */
const key =
  process.platform === 'darwin' || process.platform === 'win32'
    ? (path: string) => path.normalize('NFC').toLowerCase()
    : (path: string) => path

const listed = (paths: string[]) => paths.slice(0, 3).join(', ') + (paths.length > 3 ? ', …' : '')

/**
 * Downloads cloud run `cloudRunId`'s files into project `root`'s `.reeval/runs`, `.reeval/debug`
 * and `history` folder, and returns what to print. The history folder is the project's own, never
 * one the archive names. Nothing is written when a file is already there with other content, or
 * the archive holds anything but runs' files; each run's records land last, so a download cut
 * short leaves no record of a run without its files.
 */
export async function downloadCloudFiles(options: {
  cloudRunId: string
  url: URL
  auth: CloudAuth
  root: string
  history: ResolvedHistory
}): Promise<string[]> {
  const { cloudRunId, url, auth, root } = options
  const historyAt = relativeFile(root, options.history.dir)
  const history =
    isAbsolute(historyAt) || historyAt === '..' || historyAt.startsWith('../')
      ? null
      : historyAt.split('/').filter(Boolean)
  const areas = history
    ? `.reeval/runs, .reeval/debug and ${historyAt || '.'}`
    : `.reeval/runs and .reeval/debug (this project's history folder, ${options.history.dir}, is outside it)`
  const what = `the files of cloud run ${cloudRunId}`
  const archive = await fetchArchive(url, what, auth)
  if (!archive) return [`The cloud platform has no files of run ${cloudRunId} to download`]
  let tar: Buffer
  try {
    tar = await new Promise<Buffer>((resolve, reject) =>
      gunzip(archive, { maxOutputLength: MAX_BYTES }, (error, out) =>
        error ? reject(error) : resolve(out),
      ),
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new CloudError(
      code === 'ERR_BUFFER_TOO_LARGE'
        ? `${what} unpack to more than 2 GB: not downloading them`
        : `${what} aren't a gzip tar (${(error as Error).message})`,
    )
  }
  const unsafe: string[] = []
  const entries = readTar(tar, unsafe)
  const files: File[] = []
  let others = 0
  const within = [['.reeval', 'runs'], ['.reeval', 'debug'], ...(history ? [history] : [])]
  for (const e of entries) {
    if (e.type === 'dir') {
      const parts = e.path.split('/')
      const parent = within.some(
        (w) => parts.length <= w.length && parts.every((p, i) => p === w[i]),
      )
      if (!parent && placed(`${e.path}/-`, history) === 'outside') unsafe.push(e.path)
      continue
    }
    const at = placed(e.path, history)
    if (at === 'outside') unsafe.push(e.path)
    else if (at === 'other') others++
    else if (e.type === 'file') files.push({ ...at, data: e.data })
    else if (at.linkable) files.push({ ...at, data: Buffer.alloc(0), link: e.target })
    else unsafe.push(e.path)
  }
  if (unsafe.length) {
    throw new CloudError(
      `${what} hold ${plural(unsafe.length, 'entry', 'entries')} outside ${areas}, or a link outside a snapshot (${listed(unsafe)}): not downloading them`,
    )
  }
  const paths = new Set<string>()
  const overlaps: string[] = []
  for (const f of files) {
    if (paths.has(key(f.path))) overlaps.push(f.path)
    paths.add(key(f.path))
  }
  for (const f of files) {
    const parts = f.path.split('/')
    for (let i = 1; i < parts.length; i++) {
      if (paths.has(key(parts.slice(0, i).join('/')))) overlaps.push(f.path)
    }
  }
  if (overlaps.length) {
    throw new CloudError(
      `${what} hold a path twice, or a file where another's directory is (${listed(overlaps)}): not downloading them`,
    )
  }
  const recorded = new Set(files.filter((f) => f.record).map((f) => f.runId))
  /** The profile each run in `.reeval/runs` started with, for its `.reeval/cloud` marker. */
  const scratch = new Map<string, string | undefined>()
  for (const f of files.filter((f) => f.record)) {
    let record: ReturnType<typeof parseRecord>
    try {
      record = parseRecord(f.data, f.path)
    } catch (error) {
      if (error instanceof NewerRecordError) continue
      throw new CloudError(`${what} hold ${f.path}, which isn't a readable reeval run record`)
    }
    if (record.runId !== f.runId) {
      throw new CloudError(`${what} hold ${f.path}, the record of another run (${record.runId})`)
    }
    if (f.area === 'runs') scratch.set(f.runId, record.invocation?.profile)
  }
  const lines: string[] = []
  if (others) {
    lines.push(
      `Left out ${plural(others, 'file')} of cloud run ${cloudRunId} that ${others === 1 ? 'belongs' : 'belong'} to no run`,
    )
  }
  const unrecorded = [...new Set(files.map((f) => f.runId))].filter((id) => !recorded.has(id))
  for (const id of unrecorded) {
    lines.push(`Left out ${id}'s files: the cloud run's files have no record of it`)
  }
  const kept = files.filter((f) => recorded.has(f.runId))
  if (!recorded.size) return [...lines, `The files of cloud run ${cloudRunId} hold no run record`]
  const states = await Promise.all(kept.map((f) => stateOf(root, f)))
  const blocked = [...new Set(states.flatMap((s) => (typeof s === 'object' ? [s.blocked] : [])))]
  if (blocked.length) {
    const one = blocked.length === 1
    throw new UsageError(
      `Not downloading ${what}: ${listed(blocked)} ${one ? 'is a link or a file' : 'are links or files'} here, not a directory, and nothing is written through one. Move ${one ? 'it' : 'them'} aside to download them`,
    )
  }
  // A run downloaded from this cloud run before takes its files in .reeval/runs and .reeval/debug
  // as they are now, as a resume rewrites a run of this machine's; the history folder's stay.
  const ours = new Set<string>()
  for (const id of recorded) {
    if ((await cloudOriginOf(root, id, { exact: true }))?.cloudRunId === cloudRunId) ours.add(id)
  }
  const replaced = new Set(
    kept.filter((f, i) => states[i] === 'other' && f.area !== 'history' && ours.has(f.runId)),
  )
  const clashes = kept
    .filter((f, i) => states[i] === 'other' && !replaced.has(f))
    .map((f) => f.path)
  if (clashes.length) {
    const one = clashes.length === 1
    throw new UsageError(
      `Not downloading ${what}: ${listed(clashes)} ${one ? 'is' : 'are'} already here with other content. Move ${one ? 'it' : 'them'} aside to download them`,
    )
  }
  const fresh = kept.filter((f, i) => states[i] === 'free' || replaced.has(f))
  const order = [
    ...fresh.filter((f) => !f.record && f.link === undefined),
    ...fresh.filter((f) => f.link !== undefined),
    ...fresh.filter((f) => f.record),
  ]
  if (options.history.store.kind === 'local' && fresh.some((f) => f.area === 'history')) {
    try {
      await ensureHistoryGitignore(options.history.dir, options.history.archive)
      await ensureHistoryGitattributes(options.history.dir)
    } catch (error) {
      throw new CloudError(
        `couldn't write ${historyAt || '.'}'s .gitignore and .gitattributes (${(error as Error).message})`,
      )
    }
  }
  // Links after every file, and each file's parents checked again as it's written, so nothing is
  // written through a link, even one a case-folding filesystem takes for another name. Records
  // last, each linked into place whole from a temporary file, never over another but an earlier
  // download's of the same cloud run, after the marker that says it came from the cloud.
  for (const f of order) {
    const file = join(root, ...f.path.split('/'))
    if (f.record && f.area === 'runs' && scratch.has(f.runId)) {
      const profile = scratch.get(f.runId)
      await markCloudOrigin(root, f.runId, { cloudRunId, ...(profile ? { profile } : {}) })
    }
    try {
      const parts = f.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const at = join(root, ...parts.slice(0, i))
        const info = await lstat(at).catch(() => null)
        if (!info) await mkdir(at)
        else if (!info.isDirectory())
          throw new Error(`${parts.slice(0, i).join('/')} isn't a directory`)
      }
      if (f.link !== undefined) {
        if (replaced.has(f)) await unlink(file)
        await symlink(f.link, file)
      } else if (replaced.has(f)) {
        const tmp = join(dirname(file), `.${parts.at(-1)}.${process.pid}.tmp`)
        await writeFile(tmp, f.data, { flag: 'wx' })
        await rename(tmp, file).catch(async (error) => {
          await unlink(tmp).catch(() => {})
          throw error
        })
      } else if (!f.record) await writeFile(file, f.data, { flag: 'wx' })
      else {
        const tmp = join(dirname(file), `.${f.runId}.json.${process.pid}.tmp`)
        await writeFile(tmp, f.data)
        try {
          await link(tmp, file)
        } finally {
          await unlink(tmp).catch(() => {})
        }
      }
    } catch (error) {
      const unread = fresh.some((g) => g.record && g.runId === f.runId)
        ? ": the run's record isn't written, so reeval reads none of its files yet"
        : ''
      throw new CloudError(`couldn't write ${f.path} (${(error as Error).message})${unread}`)
    }
  }
  for (const runId of recorded) {
    const mine = kept.filter((f) => f.runId === runId)
    const wrote = fresh.filter((f) => f.runId === runId)
    const shown = (...parts: string[]) => fromCwd(join(root, ...parts))
    const scratch = mine.some((f) => f.area === 'runs') && shown('.reeval', 'runs', runId)
    const record = mine.find((f) => f.area === 'history' && f.record)
    const where = scratch || (record && shown(record.path))
    if (!wrote.length) {
      lines.push(`Run ${runId} of cloud run ${cloudRunId} is already in ${where}`)
      continue
    }
    const bytes = wrote.reduce((n, f) => n + f.data.length, 0)
    const into = scratch && wrote.some((f) => f.area === 'runs') ? ` into ${scratch}` : ''
    const copy =
      record && wrote.some((f) => f.area === 'history') ? `, recorded in ${shown(record.path)}` : ''
    const debug = mine.some((f) => f.area === 'debug')
      ? `, its debug data in ${shown('.reeval', 'debug', runId)}`
      : ', without debug data'
    lines.push(
      `Downloaded run ${runId} of cloud run ${cloudRunId}${into} (${plural(wrote.length, 'file')}, ${formatBytes(bytes)})${copy}${debug}; reeval show ${runId} reads it`,
    )
  }
  return lines
}

/**
 * `.reeval/cloud/<run>.json`: the cloud run a run in `.reeval/runs` was downloaded from, so
 * `reeval run --resume` continues it there, never on this machine.
 */
export type CloudOrigin = {
  schemaVersion: 1
  /** The run's id on the cloud platform. */
  cloudRunId: string
  /** The profile the run started with, when its record names one. */
  profile?: string
}

const originDir = (root: string) => join(root, '.reeval', 'cloud')

/** Writes run `runId`'s marker, through no link. */
async function markCloudOrigin(
  root: string,
  runId: string,
  origin: Omit<CloudOrigin, 'schemaVersion'>,
): Promise<void> {
  const dir = originDir(root)
  const marker: CloudOrigin = { schemaVersion: 1, ...origin }
  try {
    for (const at of [dirname(dir), dir]) {
      const info = await lstat(at).catch(() => null)
      if (!info) await mkdir(at)
      else if (!info.isDirectory()) throw new Error(`${relativeFile(root, at)} isn't a directory`)
    }
    const tmp = join(dir, `.${runId}.json.${process.pid}.tmp`)
    await writeFile(tmp, `${JSON.stringify(marker)}\n`, { flag: 'wx' })
    await rename(tmp, join(dir, `${runId}.json`))
  } catch (error) {
    throw new CloudError(
      `couldn't write .reeval/cloud/${runId}.json: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * The cloud run that the run of `.reeval/runs` whose id is `ref` (or, unless `exact`, starts with
 * it) was downloaded from; null when no single downloaded run matches. A marker from a newer
 * reeval is a usage error, so its run is never taken for one of this machine's.
 */
export async function cloudOriginOf(
  root: string,
  ref: string,
  { exact = false } = {},
): Promise<(CloudOrigin & { runId: string }) | null> {
  const names = await readdir(originDir(root)).catch((): string[] => [])
  const ids = names.flatMap((n) => {
    const id = n.endsWith('.json') ? n.slice(0, -'.json'.length) : ''
    return RUN_ID.test(id) && id.startsWith(ref) ? [id] : []
  })
  const runId = ids.includes(ref) ? ref : !exact && ids.length === 1 ? ids[0] : undefined
  if (!runId) return null
  const where = `.reeval/cloud/${runId}.json`
  let read: Partial<CloudOrigin> | null
  try {
    read = JSON.parse(await readFile(join(originDir(root), `${runId}.json`), 'utf8'))
  } catch {
    return null
  }
  try {
    read = readableCloudOrigin(read, where)
  } catch (error) {
    if (error instanceof NewerSchemaError) throw new UsageError(error.message)
    throw error
  }
  if (typeof read?.cloudRunId !== 'string') return null
  return {
    runId,
    schemaVersion: 1,
    cloudRunId: read.cloudRunId,
    ...(typeof read.profile === 'string' ? { profile: read.profile } : {}),
  }
}
