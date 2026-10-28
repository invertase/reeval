// A small tar reader and writer for snapshots: it reads what GNU tar, BSD tar and BusyBox
// write (ustar, GNU long names, pax headers) and writes ustar with pax headers for long paths.
// Paths that are absolute or climb out with `..` never come out of `readTar`.
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export type TarEntry =
  | { type: 'file'; path: string; mode: number; mtime: number; data: Buffer }
  | { type: 'dir'; path: string; mode: number; mtime: number }
  | { type: 'symlink'; path: string; mode: number; mtime: number; target: string }

const BLOCK = 512

const text = (b: Buffer, at: number, len: number) => {
  const field = b.subarray(at, at + len)
  const end = field.indexOf(0)
  return (end < 0 ? field : field.subarray(0, end)).toString('utf8')
}

function octal(b: Buffer, at: number, len: number): number {
  // GNU's base-256 form, for values too large for the octal digits.
  if ((b[at] ?? 0) & 0x80) {
    let n = (b[at] ?? 0) & 0x7f
    for (let i = 1; i < len; i++) n = n * 256 + (b[at + i] ?? 0)
    return n
  }
  const digits = text(b, at, len).trim()
  return digits ? Number.parseInt(digits, 8) : 0
}

/** `a/./b/` as `a/b`; null for a path that's absolute, empty or climbs out with `..`. */
export function safeTarPath(path: string): string | null {
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) return null
  const parts = path.split('/').filter((p) => p !== '' && p !== '.')
  if (!parts.length || parts.includes('..')) return null
  return parts.join('/')
}

function paxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    if (space < 0) break
    const len = Number(data.subarray(at, space).toString())
    if (!(len > 0)) break
    const record = data.subarray(space + 1, at + len - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    at += len
  }
  return out
}

/** The entries of an uncompressed tar, hard links resolved to copies of what they link to. */
export function readTar(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = []
  const files = new Map<string, Buffer>()
  let longName: string | undefined
  let longLink: string | undefined
  let pax: Record<string, string> = {}
  let at = 0
  while (at + BLOCK <= tar.length) {
    const h = tar.subarray(at, at + BLOCK)
    if (h.every((byte) => byte === 0)) break
    const type = String.fromCharCode(h[156] ?? 0)
    const size = pax.size !== undefined ? Number(pax.size) : octal(h, 124, 12)
    if (!Number.isSafeInteger(size) || size < 0) break
    const data = tar.subarray(at + BLOCK, at + BLOCK + size)
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK
    if (type === 'L') {
      longName = text(data, 0, data.length)
      continue
    }
    if (type === 'K') {
      longLink = text(data, 0, data.length)
      continue
    }
    if (type === 'x') {
      pax = { ...pax, ...paxRecords(data) }
      continue
    }
    if (type === 'g') continue
    const prefix = text(h, 257, 6).startsWith('ustar') ? text(h, 345, 155) : ''
    const name = text(h, 0, 100)
    const raw = pax.path ?? longName ?? (prefix ? `${prefix}/${name}` : name)
    const link = pax.linkpath ?? longLink ?? text(h, 157, 100)
    const mtime = pax.mtime !== undefined ? Math.floor(Number(pax.mtime)) : octal(h, 136, 12)
    longName = longLink = undefined
    pax = {}
    const path = safeTarPath(raw)
    if (!path) continue
    const mode = octal(h, 100, 8) & 0o7777
    if (type === '0' || type === '\0' || type === '7') {
      const copy = Buffer.from(data)
      files.set(path, copy)
      out.push({ type: 'file', path, mode, mtime, data: copy })
    } else if (type === '1') {
      const target = safeTarPath(link)
      const linked = target ? files.get(target) : undefined
      if (linked) out.push({ type: 'file', path, mode, mtime, data: linked })
    } else if (type === '2') {
      out.push({ type: 'symlink', path, mode, mtime, target: link })
    } else if (type === '5') {
      out.push({ type: 'dir', path, mode, mtime })
    }
  }
  return out
}

function paxEntry(fields: Record<string, string>): Buffer {
  const body = Object.entries(fields)
    .map(([k, v]) => {
      const rest = ` ${k}=${v}\n`
      const restBytes = Buffer.byteLength(rest)
      // The length counts its own digits.
      let len = restBytes + String(restBytes).length
      if (String(len).length > String(restBytes).length) len = restBytes + String(len).length
      return `${len}${rest}`
    })
    .join('')
  const data = Buffer.from(body)
  return Buffer.concat([header('PaxHeader', 0o644, data.length, 0, 'x', ''), pad(data)])
}

const pad = (data: Buffer) =>
  Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)])

function header(
  name: string,
  mode: number,
  size: number,
  mtime: number,
  type: string,
  link: string,
): Buffer {
  const h = Buffer.alloc(BLOCK)
  const put = (value: string, at: number, len: number) => {
    Buffer.from(value).copy(h, at, 0, Math.min(len, Buffer.byteLength(value)))
  }
  const num = (value: number, at: number, len: number) =>
    put(`${value.toString(8).padStart(len - 1, '0')}\0`, at, len)
  put(name, 0, 100)
  num(mode, 100, 8)
  num(0, 108, 8)
  num(0, 116, 8)
  num(size, 124, 12)
  num(Math.max(0, mtime), 136, 12)
  h.fill(0x20, 148, 156)
  put(type, 156, 1)
  put(link, 157, 100)
  put('ustar\0', 257, 6)
  put('00', 263, 2)
  let sum = 0
  for (const byte of h) sum += byte
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return h
}

const fits = (s: string) => Buffer.byteLength(s) <= 100 && /^[\x20-\x7e]*$/.test(s)

/** An uncompressed tar of `entries`, with a pax header for a path or link target ustar can't hold. */
export function writeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    const name = e.type === 'dir' ? `${e.path}/` : e.path
    const link = e.type === 'symlink' ? e.target : ''
    const long: Record<string, string> = {}
    if (!fits(name)) long.path = name
    if (!fits(link)) long.linkpath = link
    if (Object.keys(long).length) parts.push(paxEntry(long))
    const shortName = fits(name) ? name : 'long-name'
    const shortLink = fits(link) ? link : 'long-link'
    if (e.type === 'file') {
      parts.push(header(shortName, e.mode, e.data.length, e.mtime, '0', ''), pad(e.data))
    } else {
      parts.push(header(shortName, e.mode, 0, e.mtime, e.type === 'dir' ? '5' : '2', shortLink))
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}

/**
 * Writes `entries` under `dir`, never through a symbolic link: an entry whose parent on disk is a
 * link or a file is skipped, as is one whose path exists already, so nothing lands outside `dir`
 * even where the filesystem folds case. An entry the platform refuses (a name Windows can't hold,
 * a link without the right to make one) is skipped too. Returns the paths it skipped.
 */
export async function extractTar(entries: TarEntry[], dir: string): Promise<string[]> {
  const root = resolve(dir)
  const skipped: string[] = []
  await mkdir(root, { recursive: true })
  const times: Array<[string, number]> = []
  const parentsAreDirs = async (parts: string[]) => {
    let at = root
    for (const part of parts.slice(0, -1)) {
      at = join(at, part)
      const info = await lstat(at).catch(() => null)
      if (!info) await mkdir(at)
      else if (!info.isDirectory()) return false
    }
    return true
  }
  for (const e of entries) {
    const parts = e.path.split('/')
    const target = join(root, ...parts)
    try {
      if (!target.startsWith(root + sep) || !(await parentsAreDirs(parts))) {
        skipped.push(e.path)
        continue
      }
      const existing = await lstat(target).catch(() => null)
      if (e.type === 'dir') {
        if (!existing) await mkdir(target)
        else if (!existing.isDirectory()) skipped.push(e.path)
        continue
      }
      if (existing) {
        skipped.push(e.path)
        continue
      }
      if (e.type === 'symlink') await symlink(e.target, target)
      else {
        await writeFile(target, e.data, { mode: e.mode & 0o777 || 0o644, flag: 'wx' })
        times.push([target, e.mtime])
      }
    } catch {
      skipped.push(e.path)
    }
  }
  for (const [path, mtime] of times) await utimes(path, mtime, mtime).catch(() => {})
  return skipped
}

/** The tree under `dir` as entries, in a stable order; a symbolic link is kept as one, never followed. */
export async function readTree(dir: string, prefix = ''): Promise<TarEntry[]> {
  const entries: TarEntry[] = []
  for (const name of (await readdir(dir)).sort()) {
    const full = join(dir, name)
    const path = prefix ? `${prefix}/${name}` : name
    const info = await lstat(full)
    const meta = { path, mode: info.mode & 0o7777, mtime: Math.floor(info.mtimeMs / 1000) }
    if (info.isSymbolicLink())
      entries.push({ type: 'symlink', ...meta, target: await readlink(full) })
    else if (info.isDirectory()) {
      entries.push({ type: 'dir', ...meta }, ...(await readTree(full, path)))
    } else if (info.isFile()) entries.push({ type: 'file', ...meta, data: await readFile(full) })
  }
  return entries
}
