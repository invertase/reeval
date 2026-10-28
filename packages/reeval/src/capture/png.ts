import { inflateSync } from 'node:zlib'

/** Pixels that may differ between two shots of a page nothing changed: a blinking caret's. */
export const CARET_PIXELS = 48

type Pixels = { width: number; height: number; channels: number; data: Buffer }

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

/** An 8-bit, non-interlaced PNG's unfiltered pixels, or undefined for any other. */
function pixels(png: Buffer): Pixels | undefined {
  if (png.length < 33 || png.readUInt32BE(12) !== 0x49484452) return undefined
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const channels = CHANNELS[png[25] ?? -1]
  if (png[24] !== 8 || png[28] !== 0 || !channels) return undefined
  const idat: Buffer[] = []
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length))
    if (type === 'IEND') break
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const data = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (data[row + x - channels] ?? 0) : 0
      const b = y > 0 ? (data[row - stride + x] ?? 0) : 0
      const c = x >= channels && y > 0 ? (data[row - stride + x - channels] ?? 0) : 0
      let value = line[x] ?? 0
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      data[row + x] = value & 0xff
    }
  }
  return { width, height, channels, data }
}

/**
 * Whether `after` shows a different page than `before`: more than a caret's pixels differ, or the
 * size does. Bytes decide when either PNG is one this can't read.
 */
export function pageChanged(before: Buffer, after: Buffer): boolean {
  if (before.equals(after)) return false
  let a: Pixels | undefined
  let b: Pixels | undefined
  try {
    a = pixels(before)
    b = pixels(after)
  } catch {
    return true
  }
  if (!a || !b) return true
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return true
  let differ = 0
  for (let i = 0; i < a.data.length; i += a.channels) {
    if (
      a.data.compare(b.data, i, i + a.channels, i, i + a.channels) !== 0 &&
      ++differ > CARET_PIXELS
    ) {
      return true
    }
  }
  return false
}
