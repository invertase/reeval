// Protobuf bytes as a tree of field numbers and values, with no schema: two encodings of one message
// give the same tree whatever order their encoders wrote the fields in.

export type WireTree = Array<[number, bigint | number | string | WireTree]>

function varint(b: Uint8Array, at: number): [bigint, number] {
  let out = 0n
  let shift = 0n
  for (;;) {
    if (at >= b.length) throw new Error('truncated varint')
    const byte = b[at++] as number
    out |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) return [out, at]
    shift += 7n
    if (shift > 63n) throw new Error('varint too long')
  }
}

function parse(b: Uint8Array): WireTree {
  const out: WireTree = []
  let at = 0
  while (at < b.length) {
    const [tag, next] = varint(b, at)
    at = next
    const no = Number(tag >> 3n)
    const type = Number(tag & 7n)
    if (no === 0) throw new Error('field 0')
    if (type === 0) {
      const [v, n] = varint(b, at)
      if (v) out.push([no, v])
      at = n
    } else if (type === 1) {
      if (at + 8 > b.length) throw new Error('truncated i64')
      out.push([no, Buffer.from(b.subarray(at, at + 8)).toString('hex')])
      at += 8
    } else if (type === 5) {
      if (at + 4 > b.length) throw new Error('truncated i32')
      out.push([no, `i32:${Buffer.from(b.subarray(at, at + 4)).toString('hex')}`])
      at += 4
    } else if (type === 2) {
      const [len, n] = varint(b, at)
      const end = n + Number(len)
      if (end > b.length) throw new Error('truncated len')
      const body = b.subarray(n, end)
      if (body.length) out.push([no, nested(body)])
      at = end
    } else throw new Error(`wire type ${type}`)
  }
  return out.sort((a, z) => a[0] - z[0])
}

const nested = (body: Uint8Array): WireTree | string => {
  try {
    return parse(body)
  } catch {
    return Buffer.from(body).toString('hex')
  }
}

/**
 * The tree of `bytes`, fields in number order (repeated ones in their order). It leaves out what
 * proto3 treats as unset either way: zero varints and empty strings and messages.
 */
export const wireTree = (bytes: Uint8Array): WireTree => parse(bytes)

/** `tree` without field `path[last]` in the messages at `path`'s other fields, at any depth of repeats. */
export function withoutField(tree: WireTree, path: number[]): WireTree {
  const [head, ...rest] = path
  if (!rest.length) return tree.filter(([no]) => no !== head)
  return tree.map(([no, v]) =>
    no === head && Array.isArray(v) ? [no, withoutField(v, rest)] : [no, v],
  )
}
