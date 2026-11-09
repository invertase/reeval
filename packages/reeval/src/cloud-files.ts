// A cloud run's files, downloaded from the platform into this project's `.reeval/runs` and
// `.reeval/debug`, where `reeval show`, `compare`, `query` and the studio read a run of this
// machine's. The platform serves them as one gzip tar of its machine's `.reeval/runs` and
// `.reeval/debug`, which may be missing or leave the snapshots or the debug data out.
import {
  link,
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gunzip } from 'node:zlib'
import { readTar } from '@reeval/sandbox-docker'
import { type CloudAuth, CloudError, platformMessage } from './cloud-run.ts'
import { UsageError } from './errors.ts'
import { displayUrl } from './events.ts'
import { NewerRecordError, parseRecord } from './history/files.ts'
import { fromCwd, RUN_ID } from './ids.ts'
import { plural } from './text.ts'
import { formatBytes } from './view/debug.ts'

/** The most a run's files may unpack to. */
const MAX_BYTES = 2 * 1024 ** 3

const AREAS = ['runs', 'debug'] as const
type Area = (typeof AREAS)[number]

type File = {
  area: Area
  runId: string
  path: string
  data: Buffer
  record: boolean
  /** A link's target; a link only comes in a snapshot. */
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
 * Where an archive path lands, from `.reeval/`: `outside` when it's outside `runs/` and `debug/`,
 * `other` for something in them that isn't a run's.
 */
function placed(path: string): Omit<File, 'data' | 'link'> | 'outside' | 'other' {
  const parts = path.replace(/^\.reeval\//, '').split('/')
  const [area, name, ...rest] = parts
  if (!AREAS.includes(area as Area) || !name) return 'outside'
  const ext = area === 'runs' ? '.json' : '.zip'
  const whole = !rest.length && name.endsWith(ext)
  const runId = whole ? name.slice(0, -ext.length) : name
  if (!RUN_ID.test(runId) || (!rest.length && !whole)) return 'other'
  return {
    area: area as Area,
    runId,
    path: [area, name, ...rest].join('/'),
    record: whole && area === 'runs',
  }
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

/** A link in an attempt's workspace snapshot, which keeps the workspace's own links. */
const inSnapshot = (path: string) => {
  const parts = path.split('/')
  const at = parts.indexOf('snapshots', 3)
  return parts[0] === 'runs' && at > 0 && parts.length > at + 2
}

/** A path as this filesystem tells it apart: macOS's and Windows' fold case and normalize. */
const key =
  process.platform === 'darwin' || process.platform === 'win32'
    ? (path: string) => path.normalize('NFC').toLowerCase()
    : (path: string) => path

const listed = (paths: string[]) => paths.slice(0, 3).join(', ') + (paths.length > 3 ? ', …' : '')

/**
 * Downloads cloud run `cloudRunId`'s files into `root`'s `.reeval/runs` and `.reeval/debug` and
 * returns what to print. Nothing is written when a file is already there with other content, or
 * the archive holds anything but runs' files; each run's record lands last, so a download cut
 * short leaves no record of a run without its files.
 */
export async function downloadCloudFiles(options: {
  cloudRunId: string
  url: URL
  auth: CloudAuth
  root: string
}): Promise<string[]> {
  const { cloudRunId, url, auth, root } = options
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
  for (const e of entries) {
    if (e.type === 'dir') continue
    const at = placed(e.path)
    if (at === 'outside') unsafe.push(e.path)
    else if (at === 'other') others++
    else if (e.type === 'file') files.push({ ...at, data: e.data })
    else if (inSnapshot(at.path)) files.push({ ...at, data: Buffer.alloc(0), link: e.target })
    else unsafe.push(e.path)
  }
  if (unsafe.length) {
    throw new CloudError(
      `${what} hold ${plural(unsafe.length, 'entry', 'entries')} outside .reeval/runs and .reeval/debug, or a link outside a snapshot (${listed(unsafe)}): not downloading them`,
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
  for (const f of files.filter((f) => f.record)) {
    let runId: string | undefined
    try {
      runId = parseRecord(f.data, f.path).runId
    } catch (error) {
      if (error instanceof NewerRecordError) continue
      throw new CloudError(`${what} hold ${f.path}, which isn't a readable reeval run record`)
    }
    if (runId !== f.runId) {
      throw new CloudError(`${what} hold ${f.path}, the record of another run (${runId})`)
    }
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
  const dir = join(root, '.reeval')
  const states = await Promise.all(kept.map((f) => stateOf(dir, f)))
  const blocked = [
    ...new Set(states.flatMap((s) => (typeof s === 'object' ? [`.reeval/${s.blocked}`] : []))),
  ]
  if (blocked.length) {
    const one = blocked.length === 1
    throw new UsageError(
      `Not downloading ${what}: ${listed(blocked)} ${one ? 'is a link or a file' : 'are links or files'} here, not a directory, and nothing is written through one. Move ${one ? 'it' : 'them'} aside to download them`,
    )
  }
  const clashes = kept.filter((_, i) => states[i] === 'other').map((f) => `.reeval/${f.path}`)
  if (clashes.length) {
    const one = clashes.length === 1
    throw new UsageError(
      `Not downloading ${what}: ${listed(clashes)} ${one ? 'is' : 'are'} already here with other content. Move ${one ? 'it' : 'them'} aside to download them`,
    )
  }
  const fresh = kept.filter((_, i) => states[i] === 'free')
  const order = [
    ...fresh.filter((f) => !f.record && f.link === undefined),
    ...fresh.filter((f) => f.link !== undefined),
    ...fresh.filter((f) => f.record),
  ]
  // Links after every file, and each file's parents checked again as it's written, so nothing is
  // written through a link, even one a case-folding filesystem takes for another name. Records
  // last, each linked into place whole from a temporary file, never over another.
  await mkdir(dir, { recursive: true })
  for (const f of order) {
    const file = join(dir, ...f.path.split('/'))
    try {
      const parts = f.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const at = join(dir, ...parts.slice(0, i))
        const info = await lstat(at).catch(() => null)
        if (!info) await mkdir(at)
        else if (!info.isDirectory())
          throw new Error(`.reeval/${parts.slice(0, i).join('/')} isn't a directory`)
      }
      if (f.link !== undefined) await symlink(f.link, file)
      else if (!f.record) await writeFile(file, f.data, { flag: 'wx' })
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
      throw new CloudError(
        `couldn't write .reeval/${f.path} (${(error as Error).message})${unread}`,
      )
    }
  }
  for (const runId of recorded) {
    const mine = kept.filter((f) => f.runId === runId)
    const wrote = fresh.filter((f) => f.runId === runId)
    const where = fromCwd(join(dir, 'runs', runId))
    if (!wrote.length) {
      lines.push(`Run ${runId} of cloud run ${cloudRunId} is already in ${where}`)
      continue
    }
    const bytes = wrote.reduce((n, f) => n + f.data.length, 0)
    const debug = mine.some((f) => f.area === 'debug')
      ? `, its debug data in ${fromCwd(join(dir, 'debug', runId))}`
      : ', without debug data'
    lines.push(
      `Downloaded run ${runId} of cloud run ${cloudRunId} into ${where} (${plural(wrote.length, 'file')}, ${formatBytes(bytes)})${debug}; reeval show ${runId} reads it`,
    )
  }
  return lines
}
