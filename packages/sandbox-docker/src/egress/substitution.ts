// Brokered secrets: the sandbox holds a random placeholder, and the gateway swaps in the real value
// only on HTTPS requests to that secret's own hosts, and swaps it back out of their responses.
import { Transform, type TransformCallback } from 'node:stream'
import { hostAllowed } from './policy.ts'

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

/** Response headers with every real value on the host put back as its placeholder. */
export function scrubHeaders(subs: readonly Substitution[], headers: Headers): Headers {
  if (subs.length === 0) return headers
  const one = (v: string) => subs.reduce((out, s) => replaceIn(out, s.value, s.placeholder), v)
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [
      k,
      v === undefined ? v : Array.isArray(v) ? v.map(one) : one(String(v)),
    ]),
  )
}

/**
 * Replaces byte strings in a stream, including across chunk boundaries: it holds back the
 * longest `from` less one byte, so a match split between chunks is still found.
 */
export class ReplaceStream extends Transform {
  #pairs: Array<[Buffer, Buffer]>
  #hold: number
  #tail = Buffer.alloc(0)
  /** How many replacements were made. */
  count = 0

  constructor(pairs: ReadonlyArray<readonly [string, string]>) {
    super()
    this.#pairs = pairs
      .filter(([from]) => from.length > 0)
      .map(([from, to]) => [Buffer.from(from), Buffer.from(to)])
    this.#hold = Math.max(0, ...this.#pairs.map(([from]) => from.length - 1))
  }

  /**
   * Replaces every whole match in `data` (original bytes only: output is never re-scanned), and
   * returns where the unscanned tail starts, which is `data.length` when `final`.
   */
  #scan(data: Buffer, final: boolean): { out: Buffer; rest: number } {
    const parts: Buffer[] = []
    let pos = 0
    for (;;) {
      let best = -1
      let pair: [Buffer, Buffer] | undefined
      for (const p of this.#pairs) {
        const i = data.indexOf(p[0], pos)
        if (i !== -1 && (best === -1 || i < best)) {
          best = i
          pair = p
        }
      }
      if (best === -1 || !pair) break
      parts.push(data.subarray(pos, best), pair[1])
      pos = best + pair[0].length
      this.count++
    }
    const rest = final ? data.length : Math.max(pos, data.length - this.#hold)
    parts.push(data.subarray(pos, rest))
    return { out: Buffer.concat(parts), rest }
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    const data = Buffer.concat([this.#tail, chunk])
    const { out, rest } = this.#scan(data, false)
    this.#tail = Buffer.from(data.subarray(rest))
    if (out.length) this.push(out)
    done()
  }

  override _flush(done: TransformCallback): void {
    const { out } = this.#scan(this.#tail, true)
    if (out.length) this.push(out)
    done()
  }
}

/** A stream putting each real value back as its placeholder: for responses from brokered hosts. */
export const scrubber = (subs: readonly Substitution[]) =>
  new ReplaceStream(subs.map((s) => [s.value, s.placeholder] as const))

/** A stream swapping placeholders for values, for request bodies of secrets that opt in. */
export const bodySubstituter = (subs: readonly Substitution[]) =>
  new ReplaceStream(
    subs.filter((s) => s.in.includes('body')).map((s) => [s.placeholder, s.value] as const),
  )
