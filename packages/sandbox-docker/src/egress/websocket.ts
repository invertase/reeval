import { Transform } from 'node:stream'
import { replaceAll, type Substitution } from './substitution.ts'

/** The most a message may hold while its frames are gathered to be scrubbed. */
const MAX_MESSAGE = 16 * 1024 * 1024

/** One unmasked frame, as a server sends it. */
function frame(first: number, payload: Buffer): Buffer {
  const n = payload.length
  if (n < 126) return Buffer.concat([Buffer.from([first, n]), payload])
  const head = Buffer.alloc(n < 65536 ? 4 : 10)
  head[0] = first
  if (n < 65536) {
    head[1] = 126
    head.writeUInt16BE(n, 2)
  } else {
    head[1] = 127
    head.writeBigUInt64BE(BigInt(n), 2)
  }
  return Buffer.concat([head, payload])
}

/**
 * Server-to-client WebSocket frames with every real value put back as its placeholder. Each data
 * message is gathered whole, so a value split across its frames is still found, and sent on as
 * one frame; control frames pass straight through, even between a message's frames. A
 * compressed frame (the upgrade request goes up without extensions, so a server shouldn't send
 * one), or a message over 16 MiB, errors the stream rather than pass unread.
 */
export function webSocketScrubber(subs: readonly Substitution[]): Transform {
  const pairs = subs.map((s) => [s.value, s.placeholder] as const)
  let pending: Buffer = Buffer.alloc(0)
  let message: { opcode: number; parts: Buffer[]; size: number } | null = null
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      const out: Buffer[] = []
      while (pending.length >= 2) {
        const first = pending[0] ?? 0
        const second = pending[1] ?? 0
        let length = second & 0x7f
        let at = 2
        if (length === 126) {
          if (pending.length < 4) break
          length = pending.readUInt16BE(2)
          at = 4
        } else if (length === 127) {
          if (pending.length < 10) break
          const big = pending.readBigUInt64BE(2)
          if (big > BigInt(MAX_MESSAGE)) return done(new Error('a WebSocket frame over 16 MiB'))
          length = Number(big)
          at = 10
        }
        const masked = (second & 0x80) !== 0
        const maskAt = at
        if (masked) at += 4
        if (pending.length < at + length) break
        const payload = Buffer.from(pending.subarray(at, at + length))
        if (masked) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] = (payload[i] ?? 0) ^ (pending[maskAt + (i % 4)] ?? 0)
          }
        }
        pending = pending.subarray(at + length)
        const opcode = first & 0x0f
        if (first & 0x70) {
          return done(
            new Error("a compressed or extended WebSocket frame, which can't be scrubbed"),
          )
        }
        if (opcode >= 8) {
          out.push(frame(first, payload))
          continue
        }
        if (opcode === 0 ? !message : message) {
          return done(new Error('WebSocket frames out of order'))
        }
        message ??= { opcode, parts: [], size: 0 }
        message.parts.push(payload)
        message.size += payload.length
        if (message.size > MAX_MESSAGE) return done(new Error('a WebSocket message over 16 MiB'))
        if (first & 0x80) {
          out.push(frame(0x80 | message.opcode, replaceAll(Buffer.concat(message.parts), pairs)))
          message = null
        }
      }
      done(null, out.length ? Buffer.concat(out) : undefined)
    },
  })
}
