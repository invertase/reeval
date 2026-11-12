// The secret scan over every file `reeval cloud push` uploads, binary ones included. The secret
// shapes are ASCII, so a file that isn't UTF-8 text is read as UTF-16 when it looks like it, else
// byte for byte with its NULs dropped. gzip, brotli and zip files are scanned inside, entry by
// entry; a file compressed in any other format can't be scanned, and is named as unread.
import { dirname } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { bufferSource, readZip } from './archive/zip.ts'
import { type Finding, scanText } from './history/secret-scan.ts'

/** What the scan unpacks of compressed files, across one push, before it stops reading them. */
const UNPACK_BUDGET = 1024 * 2 ** 20
/** Compressed files inside compressed files it follows, at most. */
const MAX_DEPTH = 3
/** Findings named per file; the rest are counted. */
const SHOWN = 3

const UNREADABLE: Array<[RegExp, string]> = [
  [/\.(?:zst|zstd)$/i, 'zstd'],
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
}

const isGzip = (b: Buffer) => b[0] === 0x1f && b[1] === 0x8b
const isZip = (b: Buffer) =>
  b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6))

/** Whether `b` looks like UTF-16: a byte-order mark, or NUL in every other byte of its start. */
function utf16(b: Buffer): 'le' | 'be' | null {
  if (b[0] === 0xff && b[1] === 0xfe) return 'le'
  if (b[0] === 0xfe && b[1] === 0xff) return 'be'
  const n = Math.min(b.length, 512) & ~1
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

/** The text the scan reads of `b`. */
export function scanTextOf(b: Buffer): string {
  const wide = utf16(b)
  if (wide === 'le') return b.toString('utf16le').replaceAll('\0', '')
  if (wide === 'be') return Buffer.from(b).swap16().toString('utf16le').replaceAll('\0', '')
  if (!b.includes(0)) return b.toString('utf8')
  return b.toString('latin1').replaceAll('\0', '')
}

function findingText(path: string, findings: Finding[]): string {
  const shown = findings.slice(0, SHOWN).map((f) => {
    const where = [f.file, f.line === null ? null : `line ${f.line}`].filter(Boolean).join(' ')
    return `${where ? `${where}: ` : ''}${f.rule}`
  })
  const more = findings.length > SHOWN ? `, and ${findings.length - SHOWN} more` : ''
  return `${path}: ${shown.join('; ')}${more}`
}

/** Scans every file's name and contents. */
export async function scanPush(
  files: ReadonlyArray<{ path: string; data: Uint8Array }>,
): Promise<PushScan> {
  const out: PushScan = { findings: [], unread: [] }
  const budget = { left: UNPACK_BUDGET }
  for (const { path, data } of files) {
    await scanFile(path, Buffer.from(data), { depth: 0, name: true }, budget, out)
  }
  return out
}

async function scanFile(
  path: string,
  data: Buffer,
  at: { depth: number; name: boolean },
  budget: { left: number },
  out: PushScan,
): Promise<void> {
  const { depth } = at
  const name = path.slice(path.lastIndexOf('/') + 1)
  const named = at.name ? scanText(name, name) : []
  if (named.length) {
    // The name itself may be the secret, so only its folder is shown.
    out.findings.push(
      `a file name in ${dirname(path)}: ${[...new Set(named.map((f) => f.rule))].join('; ')}`,
    )
  }
  const unreadable = UNREADABLE.find(([test]) => test.test(name))
  if (unreadable) {
    out.unread.push(`${path} (${unreadable[1]}-compressed)`)
    return
  }
  if (isGzip(data) || isZip(data) || /\.br$/i.test(name)) {
    if (depth >= MAX_DEPTH) {
      out.unread.push(`${path} (compressed more than ${MAX_DEPTH} levels deep)`)
      return
    }
    await scanCompressed(path, data, depth, budget, out)
    return
  }
  const findings = scanText(path, scanTextOf(data))
  if (findings.length) out.findings.push(findingText(path, findings))
}

async function scanCompressed(
  path: string,
  data: Buffer,
  depth: number,
  budget: { left: number },
  out: PushScan,
): Promise<void> {
  const tooLarge = () => out.unread.push(`${path} (too large to unpack and scan)`)
  if (isZip(data)) {
    let zip: Awaited<ReturnType<typeof readZip>>
    try {
      zip = await readZip(bufferSource(data))
    } catch {
      // The reader's message can quote an entry's name, which may itself be the secret.
      out.unread.push(`${path} (a zip the scan can't read)`)
      return
    }
    for (const entry of zip.entries) {
      if (entry.size > budget.left) return void tooLarge()
      let inner: Buffer
      try {
        inner = await zip.read(entry)
      } catch {
        out.unread.push(`${path} (a zip the scan can't read)`)
        return
      }
      budget.left -= inner.length
      await scanFile(`${path}!/${entry.path}`, inner, { depth: depth + 1, name: true }, budget, out)
    }
    return
  }
  const gzip = isGzip(data)
  let inner: Buffer
  try {
    const options = { maxOutputLength: Math.max(1, budget.left) }
    inner = gzip ? gunzipSync(data, options) : brotliDecompressSync(data, options)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') return void tooLarge()
    if (!gzip) {
      // A `.br` name over data that isn't brotli: read it as it is.
      const findings = scanText(path, scanTextOf(data))
      if (findings.length) out.findings.push(findingText(path, findings))
      return
    }
    out.unread.push(`${path} (gzip the scan can't read: ${(error as Error).message})`)
    return
  }
  budget.left -= inner.length
  await scanFile(`${path}!`, inner, { depth: depth + 1, name: false }, budget, out)
}
