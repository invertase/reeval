// SHA-256 (FIPS 180-4) in plain TypeScript: `reeval/view` runs in browsers and Workers, where
// `node:crypto` isn't there and WebCrypto's digest is async.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

/** The lowercase hex SHA-256 of `input`; a string is hashed as UTF-8. */
export function sha256Hex(input: string | Uint8Array): string {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input
  const bytes = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64)
  bytes.set(data)
  bytes[data.length] = 0x80
  const view = new DataView(bytes.buffer)
  const bits = data.length * 8
  view.setUint32(bytes.length - 8, Math.floor(bits / 2 ** 32))
  view.setUint32(bytes.length - 4, bits >>> 0)

  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]
  const w = new Uint32Array(64)
  const word = (i: number) => w[i] ?? 0
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = word(i - 15)
      const y = word(i - 2)
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[i] = word(i - 16) + s0 + word(i - 7) + s1
    }
    let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, k = 0] = h
    for (let i = 0; i < 64; i++) {
      const ch = (e & f) ^ (~e & g)
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ch + (K[i] ?? 0) + word(i)) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      k = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    const next = [a, b, c, d, e, f, g, k]
    for (let i = 0; i < 8; i++) h[i] = ((h[i] ?? 0) + (next[i] ?? 0)) >>> 0
  }
  let hex = ''
  for (const v of h) hex += v.toString(16).padStart(8, '0')
  return hex
}
