// Brokered secrets: the sandbox holds a random placeholder, and the gateway swaps in the real value
// only on HTTPS requests to that secret's own hosts, and swaps it back out of their responses.
import { randomInt } from 'node:crypto'
import { Transform, type TransformCallback } from 'node:stream'
import { hostAllowed } from './policy.ts'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** A fresh `reeval_secret_<32 base62>`: URL-safe, so it survives any encoding a client applies. */
export function placeholder(): string {
  let out = 'reeval_secret_'
  for (let i = 0; i < 32; i++) out += BASE62[randomInt(BASE62.length)]
  return out
}

/** Where in a request a placeholder may be replaced. Bodies and queries are opt-in. */
export type SubstituteIn = 'header' | 'query' | 'body'

export type Substitution = {
  /** The variable's name, for logs and errors; never the value. */
  name: string
  placeholder: string
  value: string
  /** Host patterns as in the egress allowlist: `api.example.com`, `*.example.com`. */
  hosts: readonly string[]
  in: readonly SubstituteIn[]
  /**
   * `false` scrubs response headers only: scrubbing a body holds back its last bytes until more
   * arrive, which stalls a long-lived stream. For values the upstream never echoes in a body.
   */
  scrubBodies?: boolean
}

/** The substitutions whose hosts include `host`. */
export const substitutionsFor = (subs: readonly Substitution[], host: string) =>
  subs.filter((s) => hostAllowed(s.hosts, host))

/** Whether the gateway must decrypt connections to `host` for some substitution. */
export const substitutes = (subs: readonly Substitution[], host: string) =>
  substitutionsFor(subs, host).length > 0

type Headers = Record<string, string | string[] | undefined>

const replaceIn = (value: string, from: string, to: string) =>
  value.includes(from) ? value.split(from).join(to) : value

/**
 * The request after its host's substitutions: placeholders replaced in header values, and in the
 * query string (URL-encoded) for those opted in. Returns the names substituted, for logging without values.
 */
export function substituteRequest(
  subs: readonly Substitution[],
  request: { host: string; path: string; headers: Headers },
): { headers: Headers; path: string; names: string[] } {
  const own = substitutionsFor(subs, request.host)
  const names = new Set<string>()
  const headers: Headers = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    const one = (v: string) => {
      let out = v
      for (const s of own) {
        if (!s.in.includes('header') || !out.includes(s.placeholder)) continue
        out = replaceIn(out, s.placeholder, s.value)
        names.add(s.name)
      }
      return out
    }
    headers[key] = Array.isArray(value) ? value.map(one) : one(value)
  }
  let path = request.path
  const q = path.indexOf('?')
  if (q !== -1) {
    let query = path.slice(q)
    for (const s of own) {
      // Placeholders are URL-safe, so their encoded form is the same; the value is encoded.
      if (!s.in.includes('query') || !query.includes(s.placeholder)) continue
      query = replaceIn(query, s.placeholder, encodeURIComponent(s.value))
      names.add(s.name)
    }
    path = path.slice(0, q) + query
  }
  return { headers, path, names: [...names] }
}

/**
 * Where a request to the secrets' host still carries a placeholder the gateway leaves in place,
 * because the secret doesn't substitute there: the query without `in: ['query']`, or a header
 * with only `in: ['query']` or `['body']`. Such a request fails upstream; this names why.
 */
export function unsubstituted(
  subs: readonly Substitution[],
  request: { host: string; path: string; headers: Headers },
): Array<{ name: string; where: SubstituteIn; in: readonly SubstituteIn[] }> {
  const out: Array<{ name: string; where: SubstituteIn; in: readonly SubstituteIn[] }> = []
  const q = request.path.indexOf('?')
  const query = q === -1 ? '' : request.path.slice(q)
  const headers = Object.values(request.headers).flat().filter(Boolean).join('\n')
  for (const s of substitutionsFor(subs, request.host)) {
    if (!s.in.includes('query') && query.includes(s.placeholder)) {
      out.push({ name: s.name, where: 'query', in: s.in })
    }
    if (!s.in.includes('header') && headers.includes(s.placeholder)) {
      out.push({ name: s.name, where: 'header', in: s.in })
    }
  }
  return out
}

/** A response header value with every real value on the host put back as its placeholder. */
export const scrubValue = (subs: readonly Substitution[], value: string) =>
  subs.reduce((out, s) => replaceIn(out, s.value, s.placeholder), value)

/** Response headers with every real value on the host put back as its placeholder. */
export function scrubHeaders(subs: readonly Substitution[], headers: Headers): Headers {
  if (subs.length === 0) return headers
  const one = (v: string) => scrubValue(subs, v)
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [
      k,
      v === undefined ? v : Array.isArray(v) ? v.map(one) : one(String(v)),
    ]),
  )
}

type Pairs = Array<[Buffer, Buffer]>

const bufferPairs = (pairs: ReadonlyArray<readonly [string, string]>): Pairs =>
  pairs
    .filter(([from]) => from.length > 0)
    .map(([from, to]) => [Buffer.from(from), Buffer.from(to)])

/**
 * Replaces every whole match in `data` (original bytes only: output is never re-scanned), and
 * returns where the unscanned tail starts: `data.length` when `final`, else the start of the
 * shortest tail that could begin a match, so only bytes a later chunk might complete are held.
 */
function scan(
  pairs: Pairs,
  data: Buffer,
  final: boolean,
): { out: Buffer; rest: number; count: number } {
  const parts: Buffer[] = []
  let pos = 0
  let count = 0
  for (;;) {
    let best = -1
    let pair: [Buffer, Buffer] | undefined
    for (const p of pairs) {
      const i = data.indexOf(p[0], pos)
      if (i !== -1 && (best === -1 || i < best)) {
        best = i
        pair = p
      }
    }
    if (best === -1 || !pair) break
    parts.push(data.subarray(pos, best), pair[1])
    pos = best + pair[0].length
    count++
  }
  let rest = data.length
  if (!final) {
    const hold = Math.max(0, ...pairs.map(([from]) => from.length - 1))
    for (let i = Math.max(pos, data.length - hold); i < data.length; i++) {
      const tail = data.subarray(i)
      if (pairs.some(([from]) => from.subarray(0, tail.length).equals(tail))) {
        rest = i
        break
      }
    }
  }
  parts.push(data.subarray(pos, rest))
  return { out: Buffer.concat(parts), rest, count }
}

/** `data` with every `from` replaced by its `to`, in one pass. */
export const replaceAll = (data: Buffer, pairs: ReadonlyArray<readonly [string, string]>) =>
  scan(bufferPairs(pairs), data, true).out

/**
 * Replaces byte strings in a stream, including across chunk boundaries: it holds back a chunk's
 * tail while it could be the start of a match, so a match split between chunks is still found.
 */
export class ReplaceStream extends Transform {
  #pairs: Pairs
  #tail = Buffer.alloc(0)
  /** How many replacements were made. */
  count = 0

  constructor(pairs: ReadonlyArray<readonly [string, string]>) {
    super()
    this.#pairs = bufferPairs(pairs)
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    const data = Buffer.concat([this.#tail, chunk])
    const { out, rest, count } = scan(this.#pairs, data, false)
    this.count += count
    this.#tail = Buffer.from(data.subarray(rest))
    if (out.length) this.push(out)
    done()
  }

  override _flush(done: TransformCallback): void {
    const { out, count } = scan(this.#pairs, this.#tail, true)
    this.count += count
    if (out.length) this.push(out)
    done()
  }
}

/** The substitutions whose values are scrubbed from response bodies (see `scrubBodies`). */
export const scrubbedInBodies = (subs: readonly Substitution[]) =>
  subs.filter((s) => s.scrubBodies !== false)

/** A stream putting each real value back as its placeholder: for responses from brokered hosts. */
export const scrubber = (subs: readonly Substitution[]) =>
  new ReplaceStream(scrubbedInBodies(subs).map((s) => [s.value, s.placeholder] as const))

/** A stream swapping placeholders for values, for request bodies of secrets that opt in. */
export const bodySubstituter = (subs: readonly Substitution[]) =>
  new ReplaceStream(
    subs.filter((s) => s.in.includes('body')).map((s) => [s.placeholder, s.value] as const),
  )
