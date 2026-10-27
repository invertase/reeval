// The WebSocket scrubber alone: what it does to server control frames, without the proxy.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { webSocketScrubber } from '../src/egress/websocket.ts'

const SECRET = 'real-value-0123456789'
const HOLDER = `reeval_secret_${'Z'.repeat(32)}`
const STATUS = Buffer.from([0x03, 0xf0])

/** One frame with a payload under 126 bytes, masked as a client would send it when `masked`. */
function frame(first: number, payload: Buffer, masked = false): Buffer {
  const head = Buffer.from([first, (masked ? 0x80 : 0) | payload.length])
  if (!masked) return Buffer.concat([head, payload])
  const mask = [9, 8, 7, 6]
  return Buffer.concat([head, Buffer.from(mask), payload.map((b, i) => b ^ (mask[i % 4] ?? 0))])
}

/** `input` through a scrubber for SECRET, as `[first byte, payload]` per frame. */
async function scrub(input: Buffer): Promise<[number, Buffer][]> {
  const s = webSocketScrubber([
    { name: 'KEY', placeholder: HOLDER, value: SECRET, hosts: ['h'], in: ['header'] },
  ])
  const chunks: Buffer[] = []
  s.on('data', (d: Buffer) => chunks.push(d))
  const ended = new Promise((r) => s.once('end', r))
  s.end(input)
  await ended
  const data = Buffer.concat(chunks)
  const out: [number, Buffer][] = []
  for (let at = 0; at < data.length; ) {
    const length = (data[at + 1] ?? 0) & 0x7f
    assert.ok(length < 126, 'a control frame stays within 125 bytes')
    out.push([data[at] ?? 0, data.subarray(at + 2, at + 2 + length)])
    at += 2 + length
  }
  return out
}

describe('webSocketScrubber control frames', () => {
  test('a close reason, a ping and a pong have the value put back as the placeholder', async () => {
    const reason = Buffer.concat([STATUS, Buffer.from(`invalid key ${SECRET}`)])
    const out = await scrub(
      Buffer.concat([
        frame(0x88, reason),
        frame(0x89, Buffer.from(SECRET)),
        frame(0x8a, Buffer.from(SECRET), true),
      ]),
    )
    assert.deepEqual(out, [
      [0x88, Buffer.concat([STATUS, Buffer.from(`invalid key ${HOLDER}`)])],
      [0x89, Buffer.from(HOLDER)],
      [0x8a, Buffer.from(HOLDER)],
    ])
  })

  test('a close frame with no reason, or no status, passes unchanged', async () => {
    const out = await scrub(Buffer.concat([frame(0x88, STATUS), frame(0x88, Buffer.alloc(0))]))
    assert.deepEqual(out, [
      [0x88, STATUS],
      [0x88, Buffer.alloc(0)],
    ])
  })

  test('a close reason the placeholder makes too long is cut at a character boundary', async () => {
    // A 71-byte reason in, 146 bytes after scrubbing.
    const text = `é é ${SECRET} ${SECRET} ${SECRET}`
    const out = await scrub(frame(0x88, Buffer.concat([STATUS, Buffer.from(text)])))
    const payload = out[0]?.[1] ?? Buffer.alloc(0)
    assert.deepEqual(payload.subarray(0, 2), STATUS, 'the status code is kept')
    const reason = payload.subarray(2).toString()
    assert.ok(payload.length <= 125)
    assert.ok(
      `é é ${HOLDER} ${HOLDER} ${HOLDER}`.startsWith(reason),
      'a prefix of the scrubbed reason',
    )
    assert.ok(!reason.includes('\ufffd'), 'no character is split')
    assert.ok(!payload.toString('latin1').includes(SECRET.slice(0, 8)))
  })

  test('a multi-byte character straddling the cut is dropped whole', async () => {
    // The scrubbed reason is 46 + 76 ASCII bytes, then a 2-byte character across the 123-byte cut.
    const text = `${SECRET}${'a'.repeat(76)}é`
    const out = await scrub(frame(0x88, Buffer.concat([STATUS, Buffer.from(text)])))
    assert.equal(out[0]?.[1].subarray(2).toString(), `${HOLDER}${'a'.repeat(76)}`)
  })

  test('a ping the placeholder makes too long is cut at 125 bytes', async () => {
    const payload = Buffer.from(`${SECRET}${SECRET}${SECRET}`)
    const out = await scrub(frame(0x89, payload))
    assert.deepEqual(out, [[0x89, Buffer.from(`${HOLDER}${HOLDER}${HOLDER}`).subarray(0, 125)]])
  })
})
