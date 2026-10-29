import { inflateSync } from 'node:zlib'

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

/** The diff samples every `SAMPLE`th pixel across and down. */
const SAMPLE = 4
/** A sampled pixel differs when a channel moves more than this, so antialiasing doesn't count. */
const CHANNEL_DELTA = 32
/** The share of sampled pixels that must differ: a caret at any font size is below it. */
export const VIEW_CHANGE = 0.002

/**
 * Whether `after` looks different from `before`, two viewport shots: more than `VIEW_CHANGE` of
 * the sampled pixels differ, or the size does. Bytes decide when either PNG is one this can't read.
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
  const stride = a.width * a.channels
  let sampled = 0
  let differ = 0
  for (let y = 0; y < a.height; y += SAMPLE) {
    for (let x = 0; x < a.width; x += SAMPLE) {
      sampled++
      const at = y * stride + x * a.channels
      for (let c = 0; c < a.channels; c++) {
        if (Math.abs((a.data[at + c] ?? 0) - (b.data[at + c] ?? 0)) > CHANNEL_DELTA) {
          differ++
          break
        }
      }
    }
  }
  return differ > sampled * VIEW_CHANGE
}
