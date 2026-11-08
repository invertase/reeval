// A zip writer and reader for history archives.
//
// The writer is deterministic: entries in the order they're added, every timestamp the one it's
// given, no extra field but zip64's and no comment, so the same files give the same bytes on the
// same zlib. It writes zip64 records only where a size, an offset or the entry count needs them,
// or everywhere with `zip64: 'always'`. Each entry is compressed whole before its local header is
// written, so the header has its sizes and no data descriptor follows.
//
// The reader reads stored and deflated entries of any zip, zip64 included, through a `ZipSource`,
// so a file and anything else that reads byte ranges read the same way: the end of the source,
// then the central directory, then each entry as it's asked for. It refuses an encrypted entry,
// another compression method, a duplicate path, a path that's absolute or climbs out with `..`,
// entries whose bytes overlap or run into the central directory, and a local header that isn't
// its central directory entry's.
import { open } from 'node:fs/promises'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

export type ZipMethod = 'store' | 'deflate'

/** A zip that can't be written as asked, or can't be read. */
export class ZipError extends Error {
  override name = 'ZipError'
}

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
const END64 = 0x06064b50
const LOCATOR64 = 0x07064b50
const ZIP64_EXTRA = 0x0001
const U16 = 0xffff
const U32 = 0xffffffff
/** General-purpose flag bit 11: the name is UTF-8. */
const UTF8 = 0x0800
const ENCRYPTED = 0x0001
const LOCAL_SIZE = 30
const CENTRAL_SIZE = 46
const END_SIZE = 22
const END64_SIZE = 56
const LOCATOR64_SIZE = 20
/** A regular file, rw-r--r--, in the high half of the external attributes (Unix). */
const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0
const MADE_BY_UNIX = 3 << 8
const METHOD_CODE: Record<ZipMethod, number> = { store: 0, deflate: 8 }

/** `a/./b` as `a/b`; null for a path that's absolute, empty, a folder or climbs out with `..`. */
export function safeZipPath(path: string): string | null {
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) return null
  if (path.endsWith('/') || path.includes('\0')) return null
  const parts = path.split('/').filter((p) => p !== '' && p !== '.')
  if (!parts.length || parts.includes('..')) return null
  return parts.join('/')
}

/** CRC-32 of any length: zlib's `crc32` takes a 32-bit length, so more goes in pieces. */
export function crc32Of(data: Uint8Array, piece = 2 ** 30): number {
  let crc = 0
  for (let at = 0; at < data.length; at += piece) crc = crc32(data.subarray(at, at + piece), crc)
  return crc
}

/** MS-DOS date and time fields, as zip keeps them: two-second steps, 1980 to 2107, read as UTC. */
function dosTime(at: Date): { time: number; date: number } {
  const ms = Math.min(
    Math.max(at.getTime(), Date.UTC(1980, 0, 1)),
    Date.UTC(2107, 11, 31, 23, 59, 58),
  )
  const d = new Date(ms)
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  }
}

type Written = {
  name: Buffer
  method: ZipMethod
  crc: number
  compressedSize: number
  size: number
  offset: number
}

export type ZipWriterOptions = {
  /** Every entry's modification time. */
  mtime: Date
  /** `auto` (the default) writes zip64 records only where they're needed. */
  zip64?: 'auto' | 'always'
}

/** Writes a zip, one entry at a time, to `sink`; `finish()` writes the central directory. */
export class ZipWriter {
  readonly #sink: (bytes: Uint8Array) => Promise<void> | void
  readonly #time: { time: number; date: number }
  readonly #always: boolean
  readonly #entries: Written[] = []
  readonly #paths = new Set<string>()
  #offset = 0
  #finished = false

  constructor(sink: (bytes: Uint8Array) => Promise<void> | void, options: ZipWriterOptions) {
    this.#sink = sink
    this.#time = dosTime(options.mtime)
    this.#always = options.zip64 === 'always'
  }

  async #write(bytes: Uint8Array) {
    await this.#sink(bytes)
    this.#offset += bytes.length
  }

  /**
   * Adds a file. `deflate` (the default) stores it instead when deflating doesn't make it
   * smaller, as for data that's compressed already; the entry's method says which it got.
   */
  async add(path: string, data: Uint8Array, method: ZipMethod = 'deflate'): Promise<ZipMethod> {
    if (this.#finished) throw new ZipError(`can't add ${path}: the zip is finished`)
    if (safeZipPath(path) !== path) throw new ZipError(`${path} isn't a relative path in the zip`)
    if (this.#paths.has(path)) throw new ZipError(`${path} is in the zip already`)
    const name = Buffer.from(path, 'utf8')
    if (name.length > U16) throw new ZipError(`${path.slice(0, 40)}… is too long for a zip path`)
    this.#paths.add(path)
    let body: Uint8Array = data
    let used: ZipMethod = 'store'
    if (method === 'deflate') {
      const deflated = deflateRawSync(data, { level: 6 })
      if (deflated.length < data.length) {
        body = deflated
        used = 'deflate'
      }
    }
    const entry: Written = {
      name,
      method: used,
      crc: crc32Of(data),
      compressedSize: body.length,
      size: data.length,
      offset: this.#offset,
    }
    const zip64 = this.#always || entry.size >= U32 || entry.compressedSize >= U32
    const extra = zip64 ? zip64Extra([entry.size, entry.compressedSize]) : Buffer.alloc(0)
    const header = Buffer.alloc(LOCAL_SIZE)
    header.writeUInt32LE(LOCAL, 0)
    header.writeUInt16LE(versionNeeded(used, zip64), 4)
    header.writeUInt16LE(UTF8, 6)
    header.writeUInt16LE(METHOD_CODE[used], 8)
    header.writeUInt16LE(this.#time.time, 10)
    header.writeUInt16LE(this.#time.date, 12)
    header.writeUInt32LE(entry.crc, 14)
    header.writeUInt32LE(zip64 ? U32 : entry.compressedSize, 18)
    header.writeUInt32LE(zip64 ? U32 : entry.size, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(extra.length, 28)
    await this.#write(Buffer.concat([header, name, extra]))
    await this.#write(body)
    this.#entries.push(entry)
    return used
  }

  /** Writes the central directory and the end records; returns the zip's size in bytes. */
  async finish(): Promise<number> {
    if (this.#finished) throw new ZipError('the zip is finished already')
    this.#finished = true
    const start = this.#offset
    for (const e of this.#entries) {
      const big = {
        size: this.#always || e.size >= U32,
        compressedSize: this.#always || e.compressedSize >= U32,
        offset: this.#always || e.offset >= U32,
      }
      const extra = zip64Extra([
        ...(big.size ? [e.size] : []),
        ...(big.compressedSize ? [e.compressedSize] : []),
        ...(big.offset ? [e.offset] : []),
      ])
      const zip64 = big.size || big.compressedSize || big.offset
      const header = Buffer.alloc(CENTRAL_SIZE)
      header.writeUInt32LE(CENTRAL, 0)
      header.writeUInt16LE(MADE_BY_UNIX | versionNeeded(e.method, zip64), 4)
      header.writeUInt16LE(versionNeeded(e.method, zip64), 6)
      header.writeUInt16LE(UTF8, 8)
      header.writeUInt16LE(METHOD_CODE[e.method], 10)
      header.writeUInt16LE(this.#time.time, 12)
      header.writeUInt16LE(this.#time.date, 14)
      header.writeUInt32LE(e.crc, 16)
      header.writeUInt32LE(big.compressedSize ? U32 : e.compressedSize, 20)
      header.writeUInt32LE(big.size ? U32 : e.size, 24)
      header.writeUInt16LE(e.name.length, 28)
      header.writeUInt16LE(zip64 ? extra.length : 0, 30)
      header.writeUInt32LE(FILE_ATTRIBUTES, 38)
      header.writeUInt32LE(big.offset ? U32 : e.offset, 42)
      await this.#write(Buffer.concat([header, e.name, zip64 ? extra : Buffer.alloc(0)]))
    }
    const size = this.#offset - start
    const count = this.#entries.length
    const zip64 = this.#always || count >= U16 || size >= U32 || start >= U32
    if (zip64) {
      const end64 = Buffer.alloc(END64_SIZE)
      end64.writeUInt32LE(END64, 0)
      end64.writeBigUInt64LE(BigInt(END64_SIZE - 12), 4)
      end64.writeUInt16LE(MADE_BY_UNIX | 45, 12)
      end64.writeUInt16LE(45, 14)
      end64.writeBigUInt64LE(BigInt(count), 24)
      end64.writeBigUInt64LE(BigInt(count), 32)
      end64.writeBigUInt64LE(BigInt(size), 40)
      end64.writeBigUInt64LE(BigInt(start), 48)
      const locator = Buffer.alloc(LOCATOR64_SIZE)
      locator.writeUInt32LE(LOCATOR64, 0)
      locator.writeBigUInt64LE(BigInt(this.#offset), 8)
      locator.writeUInt32LE(1, 16)
      await this.#write(Buffer.concat([end64, locator]))
    }
    const end = Buffer.alloc(END_SIZE)
    end.writeUInt32LE(END, 0)
    end.writeUInt16LE(zip64 ? U16 : count, 8)
    end.writeUInt16LE(zip64 ? U16 : count, 10)
    end.writeUInt32LE(zip64 ? U32 : size, 12)
    end.writeUInt32LE(zip64 ? U32 : start, 16)
    await this.#write(end)
    return this.#offset
  }
}

const versionNeeded = (method: ZipMethod, zip64: boolean) =>
  zip64 ? 45 : method === 'deflate' ? 20 : 10

function zip64Extra(values: number[]): Buffer {
  const extra = Buffer.alloc(4 + values.length * 8)
  extra.writeUInt16LE(ZIP64_EXTRA, 0)
  extra.writeUInt16LE(values.length * 8, 2)
  for (const [i, v] of values.entries()) extra.writeBigUInt64LE(BigInt(v), 4 + i * 8)
  return extra
}

/** Where a zip's bytes come from: its size, and any range of it. */
export type ZipSource = {
  size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

/** A zip in memory. */
export const bufferSource = (bytes: Uint8Array): ZipSource => ({
  size: bytes.length,
  read: async (offset, length) => bytes.subarray(offset, offset + length),
})

/** A zip file, read in ranges; `close()` closes it. */
export async function fileSource(path: string): Promise<ZipSource & { close(): Promise<void> }> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    return {
      size,
      async read(offset, length) {
        const out = Buffer.alloc(length)
        let at = 0
        while (at < length) {
          const { bytesRead } = await handle.read(out, at, length - at, offset + at)
          if (bytesRead === 0) break
          at += bytesRead
        }
        return out.subarray(0, at)
      },
      close: () => handle.close(),
    }
  } catch (error) {
    await handle.close()
    throw error
  }
}

export type ZipEntry = {
  path: string
  method: ZipMethod
  crc32: number
  compressedSize: number
  size: number
  /** Where its local header starts. */
  offset: number
}

export type ZipReader = {
  /** Every file in the zip, in central-directory order; folders are left out. */
  entries: ZipEntry[]
  get(path: string): ZipEntry | undefined
  /**
   * A file's bytes, inflated and checked against its size and CRC-32. A stored file read from a
   * `bufferSource` shares the source's memory.
   */
  read(entry: ZipEntry): Promise<Buffer>
}

const u64 = (b: Buffer, at: number, what: string) => {
  const n = b.readBigUInt64LE(at)
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError(`${what} is too large to read`)
  return Number(n)
}

async function readExactly(source: ZipSource, offset: number, length: number, what: string) {
  if (offset < 0 || offset + length > source.size) {
    throw new ZipError(`${what} lies outside the zip (${source.size} bytes)`)
  }
  const read = await source.read(offset, length)
  const bytes = Buffer.from(read.buffer, read.byteOffset, read.byteLength)
  if (bytes.length !== length) throw new ZipError(`${what} was cut short`)
  return bytes
}

/** The end-of-central-directory record: the last one whose comment runs to the end. */
async function findEnd(source: ZipSource) {
  const tailLength = Math.min(source.size, END_SIZE + U16)
  const tail = await readExactly(source, source.size - tailLength, tailLength, 'the end record')
  for (let at = tail.length - END_SIZE; at >= 0; at--) {
    if (tail.readUInt32LE(at) !== END) continue
    if (at + END_SIZE + tail.readUInt16LE(at + 20) !== tail.length) continue
    return { record: tail.subarray(at, at + END_SIZE), offset: source.size - tailLength + at }
  }
  throw new ZipError('no end-of-central-directory record: not a zip, or cut short')
}

/** Reads a zip's central directory from `source`. */
export async function readZip(source: ZipSource): Promise<ZipReader> {
  const end = await findEnd(source)
  let count = end.record.readUInt16LE(10)
  let directorySize = end.record.readUInt32LE(12)
  let directoryStart = end.record.readUInt32LE(16)
  const locatorAt = end.offset - LOCATOR64_SIZE
  if (locatorAt >= 0) {
    const locator = await readExactly(source, locatorAt, LOCATOR64_SIZE, 'the zip64 locator')
    if (locator.readUInt32LE(0) === LOCATOR64) {
      const at = u64(locator, 8, 'the zip64 end record offset')
      const end64 = await readExactly(source, at, END64_SIZE, 'the zip64 end record')
      if (end64.readUInt32LE(0) !== END64) throw new ZipError('the zip64 end record is missing')
      count = u64(end64, 32, 'the entry count')
      directorySize = u64(end64, 40, 'the central directory size')
      directoryStart = u64(end64, 48, 'the central directory offset')
    }
  }
  const directory = await readExactly(
    source,
    directoryStart,
    directorySize,
    'the central directory',
  )
  const entries: ZipEntry[] = []
  const byPath = new Map<string, ZipEntry>()
  const locals = new Map<ZipEntry, LocalExpected>()
  let at = 0
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_SIZE > directory.length || directory.readUInt32LE(at) !== CENTRAL) {
      throw new ZipError(`central directory entry ${i + 1} of ${count} is missing`)
    }
    const flags = directory.readUInt16LE(at + 8)
    const code = directory.readUInt16LE(at + 10)
    const nameLength = directory.readUInt16LE(at + 28)
    const extraLength = directory.readUInt16LE(at + 30)
    const commentLength = directory.readUInt16LE(at + 32)
    const next = at + CENTRAL_SIZE + nameLength + extraLength + commentLength
    if (next > directory.length) throw new ZipError(`central directory entry ${i + 1} is cut short`)
    const nameBytes = directory.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength)
    const raw = nameBytes.toString('utf8')
    const extra = directory.subarray(
      at + CENTRAL_SIZE + nameLength,
      at + CENTRAL_SIZE + nameLength + extraLength,
    )
    let size = directory.readUInt32LE(at + 24)
    let compressedSize = directory.readUInt32LE(at + 20)
    let offset = directory.readUInt32LE(at + 42)
    const crc = directory.readUInt32LE(at + 16)
    at = next
    if (raw.endsWith('/')) continue
    const path = safeZipPath(raw)
    if (path !== raw) throw new ZipError(`${JSON.stringify(raw)} isn't a relative path in the zip`)
    if (flags & ENCRYPTED) throw new ZipError(`${path} is encrypted`)
    const method = code === 0 ? 'store' : code === 8 ? 'deflate' : null
    if (!method) throw new ZipError(`${path} uses compression method ${code}, not store or deflate`)
    if (size === U32 || compressedSize === U32 || offset === U32) {
      const values = zip64Values(extra, path)
      const take = () => {
        const v = values.shift()
        if (v === undefined) throw new ZipError(`${path}'s zip64 sizes are missing`)
        return v
      }
      if (size === U32) size = take()
      if (compressedSize === U32) compressedSize = take()
      if (offset === U32) offset = take()
    }
    if (byPath.has(path)) throw new ZipError(`${path} is in the zip twice`)
    const entry = { path, method, crc32: crc, compressedSize, size, offset } as const
    entries.push(entry)
    byPath.set(path, entry)
    locals.set(entry, { name: Buffer.from(nameBytes), code })
  }
  // Each entry's bytes must end before the next entry's local header (or the central directory)
  // starts; `readEntry` holds the local header's own length to the same bound.
  const bounds = new Map<ZipEntry, number>()
  const byOffset = [...entries].sort((a, b) => a.offset - b.offset)
  for (const [i, e] of byOffset.entries()) {
    const limit = byOffset[i + 1]?.offset ?? directoryStart
    const least = e.offset + LOCAL_SIZE + (locals.get(e)?.name.length ?? 0) + e.compressedSize
    if (least > limit) {
      throw new ZipError(`${e.path} overlaps the next entry or the central directory`)
    }
    bounds.set(e, limit)
  }
  return {
    entries,
    get: (path) => byPath.get(path),
    read: async (entry) => {
      const limit = bounds.get(entry)
      const local = locals.get(entry)
      if (limit === undefined || !local) throw new ZipError(`${entry.path} isn't this zip's entry`)
      return readEntry(source, entry, local, limit)
    },
  }
}

/** What an entry's local header repeats from its central directory entry, which isn't encrypted. */
type LocalExpected = { name: Buffer; code: number }

function zip64Values(extra: Buffer, path: string): number[] {
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at)
    const length = extra.readUInt16LE(at + 2)
    if (at + 4 + length > extra.length) throw new ZipError(`${path}'s extra field is cut short`)
    if (id === ZIP64_EXTRA) {
      const values: number[] = []
      for (let i = 0; i + 8 <= length; i += 8) {
        values.push(u64(extra, at + 4 + i, `${path}'s zip64 size`))
      }
      return values
    }
    at += 4 + length
  }
  throw new ZipError(`${path} has no zip64 extra field`)
}

async function readEntry(
  source: ZipSource,
  entry: ZipEntry,
  central: LocalExpected,
  limit: number,
): Promise<Buffer> {
  const header = await readExactly(source, entry.offset, LOCAL_SIZE, `${entry.path}'s header`)
  if (header.readUInt32LE(0) !== LOCAL) {
    throw new ZipError(`${entry.path}'s local header is missing`)
  }
  const nameLength = header.readUInt16LE(26)
  const name = await readExactly(source, entry.offset + LOCAL_SIZE, nameLength, entry.path)
  if (
    !name.equals(central.name) ||
    header.readUInt16LE(8) !== central.code ||
    header.readUInt16LE(6) & ENCRYPTED
  ) {
    throw new ZipError(`${entry.path}'s local header doesn't match its central directory entry`)
  }
  const dataAt = entry.offset + LOCAL_SIZE + nameLength + header.readUInt16LE(28)
  if (dataAt + entry.compressedSize > limit) {
    throw new ZipError(`${entry.path} overlaps the next entry or the central directory`)
  }
  if (entry.method === 'store' && entry.compressedSize !== entry.size) {
    throw new ZipError(
      `${entry.path} is stored as ${entry.compressedSize} bytes, not the ${entry.size} its entry says`,
    )
  }
  const body = await readExactly(source, dataAt, entry.compressedSize, entry.path)
  let data: Buffer
  if (entry.method === 'store') data = body
  else {
    try {
      data = inflateRawSync(body, { maxOutputLength: Math.max(entry.size, 1) })
    } catch (error) {
      throw new ZipError(`${entry.path} doesn't inflate: ${(error as Error).message}`)
    }
  }
  if (data.length !== entry.size) {
    throw new ZipError(
      `${entry.path} is ${data.length} bytes, not the ${entry.size} its entry says`,
    )
  }
  if (crc32Of(data) !== entry.crc32) throw new ZipError(`${entry.path} doesn't match its CRC-32`)
  return data
}
