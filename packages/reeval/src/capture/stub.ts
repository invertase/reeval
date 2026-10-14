import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import type { Viewport } from '../types.ts'

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}

/** A valid 1×1 PNG whose bytes are unique for `(name, port, path, viewport)`. */
export function stubPng(name: string, port: number, path: string, viewport: Viewport): Buffer {
  const digest = createHash('sha256')
    .update(
      `${name}\0${port}\0${path}\0${viewport === 'full-page' ? 'full-page' : `${viewport.width}x${viewport.height}`}`,
    )
    .digest()
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const scanline = Buffer.from([0, digest[0] ?? 0, digest[1] ?? 0, digest[2] ?? 0])
  const idat = deflateSync(scanline)
  const text = Buffer.concat([
    Buffer.from('Comment\0', 'ascii'),
    Buffer.from(digest.toString('hex'), 'ascii'),
  ])
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('tEXt', text),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** PNG IHDR width and height; throws if the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || Buffer.from(bytes.subarray(0, 8)).compare(PNG_SIG) !== 0) {
    throw new Error('not a PNG')
  }
  const view = Buffer.from(bytes.subarray(16, 24))
  return { width: view.readUInt32BE(0), height: view.readUInt32BE(4) }
}
