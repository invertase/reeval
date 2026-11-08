// History archives: one recorded run, or its debug data, as one zip (`zip.ts`) whose manifest
// (`types.ts`) hashes every other entry. `writeArchive` lands the zip whole or not at all, with
// its entries sorted by path and timestamped with the run's start, so the same files, creation
// time and reeval give the same zip. `openArchive` holds the manifest to the zip's entries, and
// each file it reads to its hash.
import { randomBytes } from 'node:crypto'
import { type FileHandle, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { RUN_ID, sha256 } from '../ids.ts'
import { PACKAGE_VERSION } from '../root.ts'
import { readableArchiveManifest } from '../view/record.ts'
import type { ArchiveFile, ArchiveManifest } from './types.ts'
import {
  fileSource,
  readZip,
  safeZipPath,
  ZipError,
  type ZipReader,
  type ZipSource,
  ZipWriter,
} from './zip.ts'

/** The manifest's path in the archive. */
export const MANIFEST_FILE = 'reeval-archive.json'

/** The largest manifest `openArchive` reads, far past a run of a hundred thousand files. */
const MAX_MANIFEST_BYTES = 64 * 2 ** 20

/** Formats that are compressed already, which an archive stores rather than deflates. */
const COMPRESSED = /\.(?:png|jpe?g|gif|webp|avif|zip|gz|tgz|zst|br|xz|bz2|mp4|webm|woff2?)$/i

/** An archive that can't be written as asked, or doesn't read as one. */
export class ArchiveError extends Error {
  override name = 'ArchiveError'
}

/** A file to archive: its path from the archive's root, and its bytes or how to read them. */
export type ArchiveInput = { path: string; data: Uint8Array | (() => Promise<Uint8Array>) }

export type WriteArchiveOptions = {
  contents: ArchiveManifest['contents']
  runId: string
  files: Iterable<ArchiveInput>
  /** Default 1. */
  revision?: number
  /** Default now. */
  createdAt?: string
  /** A `debug` archive's level; required there, refused on a `run` archive. */
  debugLevel?: ArchiveManifest['debugLevel']
  /** Zip64 records on every entry, not only where a size or offset needs them. */
  zip64?: 'auto' | 'always'
}

/** `20260924T152700Z` of a run id, as a date. */
function runStart(runId: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_/.exec(runId)
  if (!m || !RUN_ID.test(runId)) throw new ArchiveError(`${runId} isn't a run id`)
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[]
  return new Date(Date.UTC(y as number, (mo as number) - 1, d, h, mi, s))
}

const recordPath = (runId: string) => `${runId}.json`

/** Whether `path` belongs in an archive of `contents`: the record, or a file under the run. */
const inLayout = (contents: ArchiveManifest['contents'], runId: string, path: string) =>
  path.startsWith(`${runId}/`) || (contents === 'run' && path === recordPath(runId))

async function writeAll(handle: FileHandle, bytes: Uint8Array) {
  for (let at = 0; at < bytes.length; ) {
    const { bytesWritten } = await handle.write(bytes, at, bytes.length - at)
    at += bytesWritten
  }
}

/**
 * Writes `file`, an archive of `options.files`, through a temporary file renamed into place, so
 * the archive is either all there or not there. Returns its manifest.
 */
export async function writeArchive(
  file: string,
  options: WriteArchiveOptions,
): Promise<ArchiveManifest> {
  const { contents, runId } = options
  const mtime = runStart(runId)
  if (contents === 'debug' && !options.debugLevel) {
    throw new ArchiveError(`a debug archive of ${runId} needs its debug level`)
  }
  if (contents === 'run' && options.debugLevel) {
    throw new ArchiveError(`a run archive of ${runId} has no debug level`)
  }
  const inputs = [...options.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const [i, input] of inputs.entries()) {
    if (safeZipPath(input.path) !== input.path) {
      throw new ArchiveError(`${input.path} isn't a relative path in the archive`)
    }
    if (!inLayout(contents, runId, input.path)) {
      throw new ArchiveError(
        `${input.path} doesn't belong in a ${contents} archive of ${runId}: ${contents === 'run' ? `only ${recordPath(runId)} and` : 'only'} files under ${runId}/ do`,
      )
    }
    if (inputs[i - 1]?.path === input.path) throw new ArchiveError(`${input.path} is given twice`)
  }
  if (contents === 'run' && inputs[0]?.path !== recordPath(runId)) {
    throw new ArchiveError(`a run archive of ${runId} needs its record, ${recordPath(runId)}`)
  }
  // Beside the zip and named like the history folder's other writes in progress, which git ignores.
  const tmp = join(dirname(file), `.tmp-${randomBytes(6).toString('hex')}-${basename(file)}`)
  const handle = await open(tmp, 'wx')
  let landed = false
  try {
    const zip = new ZipWriter((bytes) => writeAll(handle, bytes), {
      mtime,
      zip64: options.zip64 ?? 'auto',
    })
    const files: ArchiveFile[] = []
    for (const input of inputs) {
      const data = typeof input.data === 'function' ? await input.data() : input.data
      files.push({ path: input.path, sha256: sha256(data), bytes: data.length })
      await zip.add(input.path, data, COMPRESSED.test(input.path) ? 'store' : 'deflate')
    }
    const manifest: ArchiveManifest = {
      kind: 'reeval-archive',
      schemaVersion: 1,
      contents,
      runId,
      revision: options.revision ?? 1,
      reeval: PACKAGE_VERSION,
      createdAt: options.createdAt ?? new Date().toISOString(),
      ...(options.debugLevel ? { debugLevel: options.debugLevel } : {}),
      files,
    }
    await zip.add(MANIFEST_FILE, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
    await zip.finish()
    await handle.sync()
    await handle.close()
    await rename(tmp, file)
    landed = true
    await syncDir(dirname(file))
    return manifest
  } finally {
    if (!landed) {
      await handle.close().catch(() => {})
      await rm(tmp, { force: true })
    }
  }
}

/** The rename's directory entry, flushed where the platform lets a directory be opened. */
async function syncDir(dir: string) {
  const handle = await open(dir, 'r').catch(() => null)
  await handle
    ?.sync()
    .catch(() => {})
    .finally(() => handle.close().catch(() => {}))
}

/**
 * What `openArchive` relies on. A field or a `debugLevel` a newer reeval added passes, as other
 * readers ignore what they don't know; `contents` it doesn't know isn't an archive it can read.
 */
const manifestSchema = z.looseObject({
  kind: z.literal('reeval-archive'),
  schemaVersion: z.literal(1),
  contents: z.enum(['run', 'debug']),
  runId: z.string().regex(RUN_ID, 'must be a run id'),
  revision: z.number().int().min(1),
  reeval: z.string(),
  createdAt: z.string(),
  debugLevel: z.string().optional(),
  files: z.array(
    z.object({
      path: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 in hex'),
      bytes: z.number().int().min(0),
    }),
  ),
})

/** An archive opened for reading. */
export type Archive = {
  manifest: ArchiveManifest
  has(path: string): boolean
  /** A file's bytes, checked against the manifest's hash. */
  read(path: string): Promise<Buffer>
  /** Reads every file, as `read` checks it. */
  verify(): Promise<void>
  /** Closes the file `openArchive` opened; a source it was given stays open. */
  close(): Promise<void>
}

/**
 * Opens an archive: a file, or any `ZipSource`. Refuses one whose manifest is missing or doesn't
 * fit, or whose entries aren't the manifest's files; a manifest from a newer reeval throws a
 * `NewerSchemaError`.
 */
export async function openArchive(from: string | ZipSource, what?: string): Promise<Archive> {
  const name = what ?? (typeof from === 'string' ? from : 'The archive')
  const file = typeof from === 'string' ? await fileSource(from) : null
  const source = file ?? (from as ZipSource)
  try {
    const zip = await readZip(source).catch((error) => {
      throw error instanceof ZipError
        ? new ArchiveError(`${name} isn't a readable zip: ${error.message}`)
        : error
    })
    const manifest = await readManifest(zip, name)
    return {
      manifest,
      ...reader(zip, manifest, name),
      close: async () => file?.close(),
    }
  } catch (error) {
    await file?.close()
    throw error
  }
}

async function readManifest(zip: ZipReader, name: string): Promise<ArchiveManifest> {
  const entry = zip.get(MANIFEST_FILE)
  if (!entry) {
    throw new ArchiveError(`${name} has no ${MANIFEST_FILE}, so it isn't a reeval archive`)
  }
  if (Math.max(entry.size, entry.compressedSize) > MAX_MANIFEST_BYTES) {
    const bytes = Math.max(entry.size, entry.compressedSize)
    throw new ArchiveError(`${name}'s ${MANIFEST_FILE} is ${bytes} bytes, too large to read`)
  }
  let value: unknown
  try {
    value = JSON.parse((await zip.read(entry)).toString('utf8'))
  } catch (error) {
    throw new ArchiveError(`${name}'s ${MANIFEST_FILE} doesn't read: ${(error as Error).message}`)
  }
  if ((value as { kind?: unknown } | null)?.kind !== 'reeval-archive') {
    throw new ArchiveError(`${name}'s ${MANIFEST_FILE} isn't a reeval archive manifest`)
  }
  const parsed = manifestSchema.safeParse(readableArchiveManifest(value as ArchiveManifest, name))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ArchiveError(
      `${name}'s ${MANIFEST_FILE} doesn't fit: ${issue?.path.join('.') || '(root)'} ${issue?.message}`,
    )
  }
  const manifest = parsed.data as unknown as ArchiveManifest
  const { contents, runId } = manifest
  const listed = new Set<string>()
  for (const f of manifest.files) {
    if (f.path === MANIFEST_FILE || !inLayout(contents, runId, f.path)) {
      throw new ArchiveError(
        `${name} lists ${f.path}, which doesn't belong in a ${contents} archive`,
      )
    }
    if (listed.has(f.path)) throw new ArchiveError(`${name} lists ${f.path} twice`)
    listed.add(f.path)
    const entry = zip.get(f.path)
    if (!entry) throw new ArchiveError(`${name} lists ${f.path}, which isn't in the zip`)
    if (entry.size !== f.bytes) {
      throw new ArchiveError(
        `${name}'s ${f.path} is ${entry.size} bytes in the zip, not the ${f.bytes} its manifest says`,
      )
    }
  }
  const extra = zip.entries.find((e) => e.path !== MANIFEST_FILE && !listed.has(e.path))
  if (extra) throw new ArchiveError(`${name} holds ${extra.path}, which its manifest doesn't list`)
  if (contents === 'run' && !listed.has(recordPath(runId))) {
    throw new ArchiveError(`${name} has no record, ${recordPath(runId)}`)
  }
  return manifest
}

function reader(zip: ZipReader, manifest: ArchiveManifest, name: string) {
  const files = new Map(manifest.files.map((f) => [f.path, f]))
  const read = async (path: string) => {
    const f = files.get(path)
    const entry = zip.get(path)
    if (!f || !entry) throw new ArchiveError(`${name} has no ${path}`)
    let data: Buffer
    try {
      data = await zip.read(entry)
    } catch (error) {
      if (error instanceof ZipError) throw new ArchiveError(`${name}: ${error.message}`)
      throw error
    }
    if (sha256(data) !== f.sha256) {
      throw new ArchiveError(`${name}'s ${path} doesn't match the hash in its manifest`)
    }
    return data
  }
  return {
    has: (path: string) => files.has(path),
    read,
    verify: async () => {
      for (const f of manifest.files) await read(f.path)
    },
  }
}
