// The secret scan over every file `reeval cloud push` uploads, binary ones included, and over every
// segment of every path. The secret shapes are ASCII, so a file that isn't UTF-8 text is read as
// UTF-16 when it looks like it, else byte for byte, its NULs dropped either way. Text is scanned in
// overlapping windows, so no file or unpacked stream is ever one string. gzip, zlib and zstd
// streams, found by their magic numbers, and brotli ones, found by a `.br` name, are inflated
// into those windows, and zip files are scanned entry by entry. xz, bzip2, lzip, 7z and rar files,
// found by their magic numbers or names, zstd where this Node can't inflate it, and files the scan
// can't finish are named as unread. Raw deflate has no magic number, so it reads as binary.
import { pipeline, Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import * as zlib from 'node:zlib'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { bufferSource, readZip } from './archive/zip.ts'
import { type Finding, scanText } from './history/secret-scan.ts'
import { findSecrets, findSecretsInJson } from './redact.ts'

/** The characters scanned at once. */
const WINDOW = 4 * 2 ** 20
/**
 * What each window carries over from the next. Every secret shape matches within its first
 * 64 KiB, so a match that starts in a window is found there whole or by its first 64 KiB.
 */
const OVERLAP = 64 * 2 ** 10
/** Bytes handed to the decoder at once. */
const PIECE = 2 ** 20
/** What the scan unpacks of compressed files, across one push, before it stops reading them. */
const UNPACK_BUDGET = 256 * 2 ** 20
/** Compressed files inside compressed files it follows, at most. */
const MAX_DEPTH = 3
/** Findings named per file; the rest are counted. */
const SHOWN = 3
/** Bytes read before deciding what a stream holds: its magic number, or UTF-16. */
const PEEK = 512

const MASK = '[REDACTED]'
const JSON_FILE = /\.(?:json|jsonl|ndjson)$/

const UNREADABLE: Array<[RegExp, string]> = [
  [/\.xz$/i, 'xz'],
  [/\.(?:lz|lzma)$/i, 'lzma'],
  [/\.bz2$/i, 'bzip2'],
  [/\.7z$/i, '7z'],
  [/\.rar$/i, 'rar'],
]

export type PushScan = {
  /** `<path>: <where>: <rule>`, a line per file with findings, never any part of a value. */
  findings: string[]
  /** `<path> (<why>)`, a line per file the scan couldn't read. */
  unread: string[]
  /** `path` as these lines show it: every segment that looks like a secret reads `[REDACTED]`. */
  mask: (path: string) => string
}

/** Why the scan stopped reading a file, said in place of what it found there. */
class Unread extends Error {}

const isGzip = (b: Buffer) => b[0] === 0x1f && b[1] === 0x8b
const isZip = (b: Buffer) =>
  b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6))
/** A zlib header with a 32 KiB window, as every common encoder writes: `78 01`, `5e`, `9c`, `da`. */
const isZlib = (b: Buffer) =>
  b.length >= 2 && b[0] === 0x78 && (0x7800 + (b[1] as number)) % 31 === 0
const isZstd = (b: Buffer) => b.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
const startsWith = (bytes: number[]) => (b: Buffer) =>
  b.subarray(0, bytes.length).equals(Buffer.from(bytes))

const UNREADABLE_MAGIC: Array<[(b: Buffer) => boolean, string]> = [
  [startsWith([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), 'xz'],
  // `BZh`, a block size, then the first block's or the end-of-stream's magic number.
  [
    (b) =>
      b.subarray(0, 3).toString('latin1') === 'BZh' &&
      (b[3] as number) >= 0x31 &&
      (b[3] as number) <= 0x39 &&
      ['314159265359', '177245385090'].includes(b.subarray(4, 10).toString('hex')),
    'bzip2',
  ],
  [startsWith([0x4c, 0x5a, 0x49, 0x50]), 'lzma'],
  [startsWith([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), '7z'],
  [startsWith([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]), 'rar'],
]

type Inflater = () => NodeJS.ReadWriteStream
/** Node's zstd decoder, on the Node versions that have one. */
const zstdDecompress = (zlib as { createZstdDecompress?: Inflater }).createZstdDecompress

/** Whether `b` looks like UTF-16: a byte-order mark, or NUL in every other byte of its start. */
function utf16(b: Buffer): 'le' | 'be' | null {
  if (b[0] === 0xff && b[1] === 0xfe) return 'le'
  if (b[0] === 0xfe && b[1] === 0xff) return 'be'
  const n = Math.min(b.length, PEEK) & ~1
  if (n < 8) return null
  let even = 0
  let odd = 0
  for (let i = 0; i < n; i += 2) {
    if (b[i] === 0) even++
    if (b[i + 1] === 0) odd++
  }
  const half = n / 2
  if (odd >= half * 0.9 && even < half * 0.1) return 'le'
  if (even >= half * 0.9 && odd < half * 0.1) return 'be'
  return null
}

/** A decoder for a stream that starts with `start`, carrying split characters between pieces. */
function decoderFor(start: Buffer): (piece: Buffer) => string {
  const wide = utf16(start)
  const strip = (s: string) => (s.includes('\0') ? s.replaceAll('\0', '') : s)
  if (wide === 'le') {
    const d = new StringDecoder('utf16le')
    return (piece) => strip(d.write(piece))
  }
  if (wide === 'be') {
    const d = new StringDecoder('utf16le')
    let odd: Buffer = Buffer.alloc(0)
    return (piece) => {
      const all = odd.length ? Buffer.concat([odd, piece]) : piece
      const even = all.length & ~1
      odd = Buffer.from(all.subarray(even))
      return strip(d.write(Buffer.from(all.subarray(0, even)).swap16()))
    }
  }
  if (start.includes(0)) return (piece) => strip(piece.toString('latin1'))
  const d = new StringDecoder('utf8')
  return (piece) => strip(d.write(piece))
}

const newlines = (text: string, from: number, to: number) => {
  let n = 0
  for (let i = text.indexOf('\n', from); i !== -1 && i < to; i = text.indexOf('\n', i + 1)) n++
  return n
}

/**
 * One file's text, scanned in windows of `WINDOW` characters that overlap by `OVERLAP`. A match
 * counts in the window it starts in, before the part the next window repeats, so it counts once.
 * Text that fits one window is scanned as `scanText` scans a file, a patch placed by its files.
 */
class TextScan {
  #buf = ''
  #line = 1
  #whole = true
  readonly #found: Finding[] = []
  readonly path: string
  constructor(path: string) {
    this.path = path
  }

  push(text: string): void {
    this.#buf += text
    while (this.#buf.length >= WINDOW) this.#window(false)
  }

  end(): Finding[] {
    if (this.#whole) return scanText(this.path, this.#buf)
    this.#window(true)
    return this.#found
  }

  #window(last: boolean): void {
    const text = this.#buf
    let owned = text.length
    if (!last) {
      owned -= OVERLAP
      const cut = text.lastIndexOf('\n', owned - 1)
      if (cut >= owned / 2) owned = cut + 1
    }
    const matches = (JSON_FILE.test(this.path) ? findSecretsInJson : findSecrets)(text)
      .filter((m) => m.start < owned)
      .sort((a, b) => a.start - b.start)
    let line = this.#line
    let at = 0
    for (const m of matches) {
      line += newlines(text, at, m.start)
      at = m.start
      this.#found.push({ file: null, line, what: m.rule, rule: m.rule })
    }
    this.#line += newlines(text, 0, owned)
    this.#buf = text.slice(owned)
    this.#whole = false
  }
}

async function* pieces(data: Buffer): AsyncGenerator<Buffer> {
  for (let at = 0; at < data.length; at += PIECE) yield data.subarray(at, at + PIECE)
}

/** The first `PEEK` bytes of `source` (fewer only at its end), and all of it from the start. */
async function peek(
  source: AsyncIterable<Buffer>,
): Promise<{ start: Buffer; all: AsyncGenerator<Buffer> }> {
  const it = source[Symbol.asyncIterator]()
  const head: Buffer[] = []
  let size = 0
  let done = false
  while (size < PEEK) {
    const next = await it.next()
    if (next.done) {
      done = true
      break
    }
    head.push(next.value)
    size += next.value.length
  }
  const start = Buffer.concat(head)
  async function* all(): AsyncGenerator<Buffer> {
    if (start.length) yield start
    if (done) return
    for (let next = await it.next(); !next.done; next = await it.next()) yield next.value
  }
  return { start, all: all() }
}

type Scan = {
  out: Omit<PushScan, 'mask'>
  budget: { left: number }
  mask: (path: string) => string
}

/** `stream` inflated, counted against the push's unpack budget. */
async function* inflated(
  stream: AsyncIterable<Buffer>,
  inflate: NodeJS.ReadWriteStream,
  scan: Scan,
  progress = { bytes: 0 },
): AsyncGenerator<Buffer> {
  const out = pipeline(Readable.from(stream), inflate, () => {}) as unknown as AsyncIterable<Buffer>
  for await (const chunk of out) {
    progress.bytes += chunk.length
    scan.budget.left -= chunk.length
    if (scan.budget.left < 0) throw new Unread('too large to unpack and scan')
    yield chunk
  }
}

/** Scans one stream's contents, unpacking what it can; `name` is the file name it came under. */
async function scanStream(
  path: string,
  name: string | null,
  source: AsyncIterable<Buffer>,
  depth: number,
  scan: Scan,
): Promise<void> {
  const { start, all } = await peek(source)
  const unreadable = UNREADABLE_MAGIC.find(([test]) => test(start))
  if (unreadable) throw new Unread(`${unreadable[1]}-compressed`)
  const gzip = isGzip(start)
  const zip = !gzip && isZip(start)
  const zstd = !gzip && !zip && (isZstd(start) || (name !== null && /\.zstd?$/i.test(name)))
  // A zlib header and a `.br` name can both sit on data that isn't compressed.
  const maybe: Inflater | null =
    gzip || zip || zstd
      ? null
      : isZlib(start)
        ? createInflate
        : name !== null && /\.br$/i.test(name)
          ? createBrotliDecompress
          : null
  if ((gzip || zip || zstd || maybe) && depth >= MAX_DEPTH) {
    throw new Unread(`compressed more than ${MAX_DEPTH} levels deep`)
  }
  const unpacked = path.endsWith('!') ? path : `${path}!`
  if (gzip) return scanStream(unpacked, null, inflated(all, createGunzip(), scan), depth + 1, scan)
  if (zstd) {
    if (!zstdDecompress) throw new Unread('zstd-compressed')
    return scanStream(unpacked, null, inflated(all, zstdDecompress(), scan), depth + 1, scan)
  }
  if (zip) {
    const chunks: Buffer[] = []
    for await (const chunk of all) chunks.push(chunk)
    return scanZip(path.replace(/!$/, ''), Buffer.concat(chunks), depth + 1, scan)
  }
  if (maybe) {
    const chunks: Buffer[] = []
    for await (const chunk of all) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const progress = { bytes: 0 }
    try {
      return await scanStream(
        unpacked,
        null,
        inflated(pieces(raw), maybe(), scan, progress),
        depth + 1,
        scan,
      )
    } catch (error) {
      // Data that only looked compressed and gave nothing when inflated: read it as it is.
      if (error instanceof Unread || progress.bytes > 0 || raw.length === 0) throw error
      return scanPlain(path, raw, pieces(raw), scan)
    }
  }
  return scanPlain(path, start, all, scan)
}

/** Scans a stream as text, decoded as its first bytes, `start`, say. */
async function scanPlain(
  path: string,
  start: Buffer,
  all: AsyncIterable<Buffer>,
  scan: Scan,
): Promise<void> {
  const decode = decoderFor(start)
  const text = new TextScan(path)
  for await (const chunk of all) {
    for (let at = 0; at < chunk.length; at += PIECE) {
      text.push(decode(chunk.subarray(at, at + PIECE)))
    }
  }
  const findings = text.end()
  if (findings.length) scan.out.findings.push(findingText(scan.mask(path), findings))
}

async function scanZip(path: string, data: Buffer, depth: number, scan: Scan): Promise<void> {
  let zip: Awaited<ReturnType<typeof readZip>>
  try {
    zip = await readZip(bufferSource(data))
  } catch {
    // The reader's message can quote an entry's name, which may itself be the secret.
    throw new Unread("a zip the scan can't read")
  }
  for (const entry of zip.entries) {
    await scanFile(`${path}!/${entry.path}`, depth, scan, async () => {
      if (entry.method !== 'store') {
        if (entry.size > scan.budget.left) throw new Unread('too large to unpack and scan')
        scan.budget.left -= entry.size
      }
      try {
        return await zip.read(entry)
      } catch {
        throw new Unread("a zip the scan can't read")
      }
    })
  }
}

/** Scans one file's path and contents, saying it unread where the scan can't finish. */
async function scanFile(
  path: string,
  depth: number,
  scan: Scan,
  data: () => Promise<Buffer>,
): Promise<void> {
  const shown = scan.mask(path)
  const name = path.slice(path.lastIndexOf('/') + 1)
  const unreadable = UNREADABLE.find(([test]) => test.test(name))
  if (unreadable) {
    scan.out.unread.push(`${shown} (${unreadable[1]}-compressed)`)
    return
  }
  try {
    await scanStream(path, name, pieces(await data()), depth, scan)
  } catch (error) {
    const why = error instanceof Unread ? error.message : "the scan couldn't finish reading it"
    scan.out.unread.push(`${shown} (${why})`)
  }
}

function findingText(path: string, findings: Finding[]): string {
  const shown = findings.slice(0, SHOWN).map((f) => {
    const where = [f.file, f.line === null ? null : `line ${f.line}`].filter(Boolean).join(' ')
    return `${where ? `${where}: ` : ''}${f.rule}`
  })
  const more = findings.length > SHOWN ? `, and ${findings.length - SHOWN} more` : ''
  return `${path}: ${shown.join('; ')}${more}`
}

/** Scans every file's contents and every segment of its path, nested zips' entries included. */
export async function scanPush(
  files: ReadonlyArray<{ path: string; data: Uint8Array }>,
): Promise<PushScan> {
  const out: Omit<PushScan, 'mask'> = { findings: [], unread: [] }
  const segments = new Map<string, string[]>()
  const flagged = new Set<string>()
  const rulesOf = (segment: string) => {
    let rules = segments.get(segment)
    if (!rules) {
      // A name can carry a secret percent-encoded (`ghp%5F…`), as a URL path or a saved URL does.
      let decoded = segment
      try {
        decoded = decodeURIComponent(segment)
      } catch {}
      const found = findSecrets(segment)
      if (decoded !== segment) found.push(...findSecrets(decoded))
      rules = [...new Set(found.map((m) => m.rule))]
      segments.set(segment, rules)
    }
    return rules
  }
  const mask = (path: string) =>
    path
      .split('/')
      .map((s) => (rulesOf(s).length ? MASK : s))
      .join('/')
  const scan: Scan = {
    out,
    budget: { left: UNPACK_BUDGET },
    mask: (path) => {
      const parts = path.split('/')
      for (let i = 0; i < parts.length; i++) {
        const rules = rulesOf(parts[i] as string)
        const prefix = parts.slice(0, i + 1).join('/')
        if (rules.length && !flagged.has(prefix)) {
          flagged.add(prefix)
          out.findings.push(`${mask(prefix)}: name: ${rules.join('; ')}`)
        }
      }
      return mask(path)
    },
  }
  for (const { path, data } of files) {
    await scanFile(path, 0, scan, async () =>
      Buffer.from(data.buffer, data.byteOffset, data.length),
    )
  }
  return { ...out, mask }
}
