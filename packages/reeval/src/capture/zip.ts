import { inflateRawSync } from 'node:zlib'

const LOCAL = 0x04034b50

/** Extracts a zip (store or deflate) into `files` keyed by posix path. */
export function unzip(bytes: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(bytes)
  const files = new Map<string, Buffer>()
  let i = 0
  while (i + 30 <= buf.length) {
    const sig = buf.readUInt32LE(i)
    if (sig !== LOCAL) break
    const method = buf.readUInt16LE(i + 8)
    const comp = buf.readUInt32LE(i + 18)
    const nameLen = buf.readUInt16LE(i + 26)
    const extra = buf.readUInt16LE(i + 28)
    const name = buf.toString('utf8', i + 30, i + 30 + nameLen)
    const start = i + 30 + nameLen + extra
    const raw = buf.subarray(start, start + comp)
    if (name.endsWith('/')) {
      i = start + comp
      continue
    }
    if (method === 0) files.set(name, Buffer.from(raw))
    else if (method === 8) files.set(name, Buffer.from(inflateRawSync(raw)))
    else throw new Error(`zip method ${method} is not supported (${name})`)
    i = start + comp
  }
  return files
}
