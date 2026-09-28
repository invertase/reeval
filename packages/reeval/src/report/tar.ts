import { gzipSync } from 'node:zlib'

export type TarEntry = { path: string; data: Buffer }

const BLOCK = 512

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

/** `path` as ustar's 155-byte prefix and 100-byte name, split on a `/`. */
function splitPath(path: string): { prefix: string; name: string } {
  if (Buffer.byteLength(path) <= 100) return { prefix: '', name: path }
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i)
    const name = path.slice(i + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { prefix, name }
  }
  throw new Error(`${path} is too long for a tar entry`)
}

function header(path: string, size: number, mtime: number): Buffer {
  const block = Buffer.alloc(BLOCK)
  const { prefix, name } = splitPath(path)
  block.write(name, 0)
  block.write(octal(0o644, 8), 100)
  block.write(octal(0, 8), 108)
  block.write(octal(0, 8), 116)
  block.write(octal(size, 12), 124)
  block.write(octal(mtime, 12), 136)
  block.write(' '.repeat(8), 148)
  block.write('0', 156)
  block.write('ustar\0', 257)
  block.write('00', 263)
  block.write(prefix, 345)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return block
}

/** A gzipped ustar archive of regular files, readable by `tar -xzf`. */
export function tarGz(entries: TarEntry[], mtime = Math.floor(Date.now() / 1000)): Buffer {
  const parts: Buffer[] = []
  for (const { path, data } of entries) {
    parts.push(header(path, data.length, mtime), data)
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return gzipSync(Buffer.concat(parts))
}
