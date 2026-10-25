/** What a masked value reads as. */
export const REDACTED = '[REDACTED]'

export const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

/** Where a value has its first whitespace or control character, from 1; 0 when it has none. */
export const badCharacterAt = (value: string) =>
  [...value].findIndex((c) => /[\s\p{Cc}]/u.test(c)) + 1

/** Well-known credential shapes, masked even when they aren't in this process's environment. */
const TOKEN_PATTERNS: Array<{ rule: string; pattern: RegExp }> = [
  { rule: 'Google API key', pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { rule: 'OpenAI or Anthropic key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { rule: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g },
  { rule: 'GitHub token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { rule: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  {
    rule: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    rule: 'private key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
]

/** Values declared with `secret()`, masked whatever their variable is called. */
const declared = new Set<string>()

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 4) declared.add(value)
}

/** What a found secret is: the variable it's the value of, or the credential shape it has. */
const DECLARED_RULE = 'a declared secret'
const valueRule = (name: string) => `the value of ${name}`

/** Encoded forms shorter than this aren't masked, so they can't eat ordinary text. */
const MIN_ENCODED = 8

/**
 * The stretch of base64 that encodes `value` wherever it starts in a longer input: one per byte
 * offset (0, 1 or 2), without the characters shared with the bytes around it. Plus the URL-safe
 * alphabet of each.
 */
export function base64Forms(value: string): string[] {
  const bytes = Buffer.from(value)
  const out: string[] = []
  for (const offset of [0, 1, 2]) {
    const padded = Buffer.concat([Buffer.alloc(offset), bytes])
    const encoded = padded.toString('base64').replace(/=+$/, '')
    const skip = Math.ceil((offset * 8) / 6)
    const tail = padded.length % 3
    const keep = Math.floor(padded.length / 3) * 4 + tail
    const form = encoded.slice(skip, keep)
    out.push(form, form.replaceAll('+', '-').replaceAll('/', '_'))
  }
  return out
}

/** How a value may appear once a client or a log has encoded it: JSON, URL and base64. */
export function encodedForms(value: string): string[] {
  const forms = [
    jsonEscaped(value),
    encodeURIComponent(value),
    new URLSearchParams({ v: value }).toString().slice(2),
    ...base64Forms(value),
  ]
  return [...new Set(forms)].filter((f) => f !== value && f.length >= MIN_ENCODED)
}

const jsonEscaped = (s: string) => JSON.stringify(s).slice(1, -1)

const formsCache = new Map<string, string[]>()
/**
 * The value and its encoded forms, each also as it reads inside a JSON string: secret scans and
 * plain-text redaction read serialised JSON, and a JSON string can hold JSON the agent printed.
 */
const formsOf = (value: string) => {
  let forms = formsCache.get(value)
  if (!forms) {
    forms = [...new Set([value, ...encodedForms(value)].flatMap((f) => [f, jsonEscaped(f)]))]
    formsCache.set(value, forms)
  }
  return forms
}

/** A stretch of a secret at least this long is masked on its own, like the key's last 12 characters. */
export const MIN_FRAGMENT = 8

/**
 * Whether a secret-named variable's value looks like a credential, so its fragments are masked
 * too. Paths, URLs and prose (`SSH_KEY_PATH=/home/me/.ssh/id_rsa`) would otherwise mask every
 * `/home/me` in the output. Declared secrets of 12 or more characters always count.
 */
const tokenLike = (value: string) =>
  value.length >= 16 &&
  /^[\w.~+/=:-]+$/.test(value) &&
  !/^[/~.]/.test(value) &&
  !value.includes('://') &&
  /[A-Za-z]/.test(value) &&
  /\d/.test(value)

/** Windows that could be an ordinary word or number (`password`, `20260926`) aren't masked alone. */
const WORDISH = /^(?:[a-z]+|[A-Z]+|\d+)$/
/**
 * Windows with quotes, backslashes, commas, brackets or whitespace aren't masked alone: they can
 * match the structure of serialised JSON (`","sha256":"`) and break the record around them.
 */
const STRUCTURAL = /["'\\,:{}[\]\s]/

type Secrets = {
  /** Whole values and their encoded forms, longest first. */
  forms: string[]
  /**
   * The forms masked in a JSON key that reads as a field name: those of `MIN_FRAGMENT` or more
   * characters, so a short declared secret (`error`, `text`) can't rename a record's fields.
   */
  keyForms: string[]
  /** Text shorter than this can't hold any form, window or token shape. */
  shortest: number
  /** Each form's rule: the value of which variable, or a declared secret. */
  formRules: Map<string, string>
  /** Every `MIN_FRAGMENT`-character window of the values whose fragments are masked, and its rule. */
  windows: Map<string, string>
  /** Bit `i` is set when some window starts with the two characters that hash to `i`. */
  starts: Uint8Array
}

const pairHash = (text: string, i: number) =>
  ((text.charCodeAt(i) * 31) ^ text.charCodeAt(i + 1)) & 0xffff

let cached: { key: string; secrets: Secrets } | undefined

function envSecrets(env: NodeJS.ProcessEnv): Secrets {
  const rules = new Map<string, string>()
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && value && value.length >= 8 && !rules.has(value)) {
      rules.set(value, valueRule(name))
    }
  }
  for (const value of declared) if (!rules.has(value)) rules.set(value, DECLARED_RULE)
  const values = [...rules.keys()]
  const key = values.map((v) => `${declared.has(v) ? 'd' : 'n'}${rules.get(v)}\0${v}`).join('\0')
  if (cached?.key === key) return cached.secrets
  const formRules = new Map<string, string>()
  for (const value of values) {
    for (const form of formsOf(value)) {
      if (!formRules.has(form)) formRules.set(form, rules.get(value) as string)
    }
  }
  const forms = [...formRules.keys()].sort((a, b) => b.length - a.length)
  const windows = new Map<string, string>()
  const starts = new Uint8Array(0x10000)
  for (const value of values) {
    if (!(declared.has(value) ? value.length >= 12 : tokenLike(value))) continue
    for (let i = 0; i + MIN_FRAGMENT <= value.length; i++) {
      const window = value.slice(i, i + MIN_FRAGMENT)
      if (WORDISH.test(window) || STRUCTURAL.test(window)) continue
      if (!windows.has(window)) windows.set(window, rules.get(value) as string)
      starts[pairHash(value, i)] = 1
    }
  }
  const keyForms = forms.filter((f) => f.length >= MIN_FRAGMENT)
  const shortest = Math.min(MIN_FRAGMENT, ...forms.map((f) => f.length))
  const secrets = { forms, keyForms, shortest, formRules, windows, starts }
  cached = { key, secrets }
  return secrets
}

/** The `[start, end)` stretches of `text` made of some secret's fragments, merged, with the first one's rule. */
function fragmentRanges(
  text: string,
  { windows, starts }: Secrets,
): Array<[number, number, string]> {
  const ranges: Array<[number, number, string]> = []
  if (windows.size === 0) return ranges
  for (let i = 0; i + MIN_FRAGMENT <= text.length; i++) {
    if (!starts[pairHash(text, i)]) continue
    const rule = windows.get(text.slice(i, i + MIN_FRAGMENT))
    if (rule === undefined) continue
    const last = ranges.at(-1)
    if (last && i <= last[1]) last[1] = i + MIN_FRAGMENT
    else ranges.push([i, i + MIN_FRAGMENT, rule])
  }
  return ranges
}

function maskFragments(text: string, secrets: Secrets): string {
  const ranges = fragmentRanges(text, secrets)
  if (ranges.length === 0) return text
  let out = ''
  let at = 0
  for (const [start, end] of ranges) {
    out += `${text.slice(at, start)}${REDACTED}`
    at = end
  }
  return out + text.slice(at)
}

/**
 * Masks the values of secret-looking environment variables and declared secrets, raw or
 * JSON-, URL- or base64-encoded, any stretch of `MIN_FRAGMENT` or more of their characters, and
 * well-known token shapes, anywhere in `text`.
 */
export const redactSecrets = (text: string, env: NodeJS.ProcessEnv = process.env): string =>
  redactWith(text, envSecrets(env))

function redactWith(text: string, secrets: Secrets, forms = secrets.forms): string {
  if (text.length < secrets.shortest) return text
  let out = text
  for (const secret of forms) out = out.replaceAll(secret, REDACTED)
  out = maskFragments(out, secrets)
  for (const { pattern } of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED)
  return out
}

/** A JSON string literal: `[start, end)` with its quotes, and whether it's an object's key. */
type Literal = { start: number; end: number; key: boolean }

/** The string literals of valid JSON text, in order. */
function literals(json: string): Literal[] {
  const out: Literal[] = []
  for (let i = json.indexOf('"'); i !== -1; i = json.indexOf('"', i)) {
    let j = i + 1
    while (json[j] !== '"') j += json[j] === '\\' ? 2 : 1
    let next = j + 1
    while (next < json.length && ' \t\r\n'.includes(json[next] as string)) next++
    out.push({ start: i, end: j + 1, key: json[next] === ':' })
    i = j + 1
  }
  return out
}

const isJson = (text: string) => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

type Chunk = { at: number; text: string; json: boolean }

/**
 * `text` after any byte-order mark, as JSON documents: the whole of it when it parses, else each
 * line (JSON Lines), with each run of lines that aren't JSON kept together, so a pattern spanning
 * them (a private key) is still whole. Blank lines count as JSON: they have no literals. Joined
 * with newlines, the chunks' texts are `text` after the mark.
 */
function jsonChunks(text: string): Chunk[] {
  const bom = text.startsWith('\uFEFF') ? 1 : 0
  const body = text.slice(bom)
  if (isJson(body)) return [{ at: bom, text: body, json: true }]
  const chunks: Chunk[] = []
  let at = bom
  for (const line of body.split('\n')) {
    const json = !line.trim() || isJson(line)
    const last = chunks.at(-1)
    if (!json && last && !last.json) last.text += `\n${line}`
    else chunks.push({ at, text: line, json })
    at += line.length + 1
  }
  return chunks
}

/** Maps valid JSON's string literals, re-escaping the ones `map` changes. */
function mapLiterals(json: string, map: (value: string, key: boolean) => string): string {
  let out = ''
  let at = 0
  for (const { start, end, key } of literals(json)) {
    const raw = json.slice(start, end)
    const value: string = raw.includes('\\') ? JSON.parse(raw) : raw.slice(1, -1)
    const mapped = map(value, key)
    if (mapped === value) continue
    out += `${json.slice(at, start)}${JSON.stringify(mapped)}`
    at = end
  }
  return out + json.slice(at)
}

/**
 * Serialised JSON or JSON Lines with every string literal (object keys included) passed through
 * `map`, and the text kept byte for byte outside the ones it changes, so `null`, numbers and
 * booleans stay as they are. A line that isn't JSON goes through `map` whole, as a value.
 */
export function mapJsonStrings(text: string, map: (value: string, key: boolean) => string): string {
  const chunks = jsonChunks(text)
  const mapped = chunks.map((c) => (c.json ? mapLiterals(c.text, map) : map(c.text, false)))
  return text.slice(0, chunks[0]?.at ?? 0) + mapped.join('\n')
}

const FIELD_NAME = /^[A-Za-z_$][\w$]*$/

const redactLiteral = (secrets: Secrets) => (value: string, key: boolean) =>
  redactWith(value, secrets, key && FIELD_NAME.test(value) ? secrets.keyForms : secrets.forms)

/**
 * `value` serialised (`JSON.stringify(value, null, space)`), with secrets masked as
 * `redactSecrets` masks them but only inside its strings: the result is valid JSON of the same
 * shape, and `null`, numbers and booleans stay as they are whatever the secrets are, so a secret
 * held as a number isn't masked. In a key that reads as a field name (`durationMs`), only forms
 * of `MIN_FRAGMENT` or more characters are masked; other keys (paths, header names) are masked as
 * values are.
 */
export function redactJson(
  value: unknown,
  space?: number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return mapLiterals(JSON.stringify(value, null, space), redactLiteral(envSecrets(env)))
}

/**
 * `value` with its strings masked as `redactJson` masks them, as a JSON value again: what a model
 * is sent, so it reads as the record of it will once that's written.
 */
export const redactValue = <T>(value: T, env: NodeJS.ProcessEnv = process.env): T =>
  JSON.parse(redactJson(value, undefined, env))

/**
 * Serialised JSON or JSON Lines, masked as `redactJson` masks a value, with the text kept byte
 * for byte outside the strings it masks. A line that isn't JSON is masked as plain text.
 */
export const redactJsonText = (text: string, env: NodeJS.ProcessEnv = process.env): string =>
  mapJsonStrings(text, redactLiteral(envSecrets(env)))

/** A JSON object key masked as `redactJson` masks one. */
export const redactKey = (key: string, env: NodeJS.ProcessEnv = process.env): string =>
  redactLiteral(envSecrets(env))(key, true)

/** One stretch `redactSecrets` would mask: where it is in the text, and why. */
export type SecretMatch = {
  start: number
  end: number
  /** `the value of NAME`, `a declared secret`, or a credential shape such as `Google API key`. */
  rule: string
  /** Whether `rule` names a variable or a declared secret, so no part of the value may be shown. */
  known: boolean
}

/** What `redactSecrets` would mask, in order. Used as a last check before anything leaves the machine. */
export function findSecrets(text: string, env: NodeJS.ProcessEnv = process.env): SecretMatch[] {
  const secrets = envSecrets(env)
  const found: SecretMatch[] = []
  let rest = text
  for (const secret of secrets.forms) {
    let at = rest.indexOf(secret)
    if (at === -1) continue
    const rule = secrets.formRules.get(secret) as string
    while (at !== -1) {
      found.push({ start: at, end: at + secret.length, rule, known: true })
      at = rest.indexOf(secret, at + secret.length)
    }
    // Same length, so later matches keep their offsets; no window or pattern spans a NUL.
    rest = rest.replaceAll(secret, '\0'.repeat(secret.length))
  }
  for (const [start, end, rule] of fragmentRanges(rest, secrets)) {
    found.push({ start, end, rule, known: true })
  }
  for (const { rule, pattern } of TOKEN_PATTERNS) {
    for (const m of rest.matchAll(pattern)) {
      found.push({ start: m.index, end: m.index + m[0].length, rule, known: false })
    }
  }
  return found.sort((a, b) => a.start - b.start)
}

/**
 * The end of a cut at or before `end` that goes through no stretch `findSecrets` finds, for text
 * that's kept unmasked but masked later: a cut through a secret would keep a part the later mask
 * can't match.
 */
export function cutOutsideSecrets(
  text: string,
  end: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  let at = end
  for (const m of findSecrets(text, env).reverse()) if (m.start < at && m.end > at) at = m.start
  return at
}

/**
 * What `redactJsonText` would mask in serialised JSON or JSON Lines: `findSecrets`' matches inside
 * the string literals it would change, and every match in lines that aren't JSON.
 */
export function findSecretsInJson(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): SecretMatch[] {
  const found = findSecrets(text, env)
  if (found.length === 0) return found
  const redact = redactLiteral(envSecrets(env))
  type Span = { start: number; end: number; masked: () => boolean }
  const spans: Span[] = jsonChunks(text).flatMap((c): Span[] =>
    c.json
      ? literals(c.text).map(({ start, end, key }) => {
          let masked: boolean | undefined
          return {
            start: c.at + start + 1,
            end: c.at + end - 1,
            masked: () => {
              if (masked === undefined) {
                const value: string = JSON.parse(c.text.slice(start, end))
                masked = redact(value, key) !== value
              }
              return masked
            },
          }
        })
      : [{ start: c.at, end: c.at + c.text.length, masked: () => true }],
  )
  return found.filter((m) => {
    let lo = 0
    let hi = spans.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((spans[mid] as Span).start <= m.start) lo = mid
      else hi = mid - 1
    }
    const span = spans[lo]
    return span !== undefined && span.start <= m.start && m.end <= span.end && span.masked()
  })
}

type Leaf = { line: number; path: (string | number)[]; value: string }

/** Every string value of `value` (not its keys), with its path. */
function leaves(value: unknown, line: number, path: (string | number)[], out: Leaf[]): void {
  if (typeof value === 'string') out.push({ line, path, value })
  else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) leaves(v, line, [...path, i], out)
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, line, [...path, k], out)
  }
}

/** A `[start, end)` stretch of one leaf to mask; `lead` reads `[REDACTED]`, the rest go. */
type Cut = { start: number; end: number; lead: boolean }

function cutLeaf(value: string, cuts: Cut[]): string {
  const sorted = [...cuts].sort((a, b) => a.start - b.start)
  const merged: Cut[] = []
  for (const c of sorted) {
    const last = merged.at(-1)
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end)
      last.lead ||= c.lead
    } else merged.push({ ...c })
  }
  let out = ''
  let at = 0
  for (const c of merged) {
    out += `${value.slice(at, c.start)}${c.lead ? REDACTED : ''}`
    at = c.end
  }
  return out + value.slice(at)
}

/**
 * The fields that tell one stream from another at the same path: an AI SDK part's block `id`, and
 * an ACP update's `messageId` and `sessionUpdate` (a thought chunk beside a message chunk).
 */
const STREAM_IDS = ['id', 'messageId', 'sessionUpdate'] as const

/**
 * JSON Lines with each secret that only shows once strings on several lines are joined masked: a
 * reply streamed as short deltas, one stream part per line, where no single string holds enough
 * of the secret for `redactJsonText` to catch it. The strings at one path (`part.text`,
 * `rawValue.content.text`) are joined in line order, also per the `type` beside them, and also
 * per the `STREAM_IDS` above them, so interleaved text and reasoning, two text blocks, or thought
 * and message chunks still join; a match spanning two or more strings has its first piece read
 * `[REDACTED]` and its other pieces emptied. Lines that aren't JSON, and lines with nothing to
 * mask, are kept byte for byte.
 */
export function redactSplitSecrets(
  lines: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const parsed = lines.map((line) => {
    try {
      return { ok: true as const, value: JSON.parse(line) as unknown }
    } catch {
      return { ok: false as const }
    }
  })
  const all: Leaf[] = []
  parsed.forEach((p, i) => {
    if (p.ok) leaves(p.value, i, [], all)
  })
  const groups = new Map<string, Leaf[]>()
  const join = (key: string, leaf: Leaf) => {
    const group = groups.get(key)
    if (group) group.push(leaf)
    else groups.set(key, [leaf])
  }
  type Node = Record<string | number, unknown>
  /** The objects and arrays above `leaf`, from its line's value down to its parent. */
  const ancestors = (leaf: Leaf): Node[] => {
    let node = (parsed[leaf.line] as { value: unknown }).value as Node
    const out: Node[] = []
    for (const k of leaf.path) {
      out.push(node)
      node = node[k] as Node
    }
    return out
  }
  const parentOf = (leaf: Leaf): Node => ancestors(leaf).at(-1) as Node
  for (const leaf of all) {
    const path = JSON.stringify(leaf.path.map((k) => (typeof k === 'number' ? '#' : k)))
    join(`${path}\0`, leaf)
    const above = ancestors(leaf)
    const type = above.at(-1)?.type
    if (typeof type === 'string') join(`${path}\0${type}`, leaf)
    const stream = above.flatMap((node) =>
      STREAM_IDS.flatMap((k) => (typeof node[k] === 'string' ? [`${k}=${node[k]}`] : [])),
    )
    if (stream.length > 0) join(`${path}\0${type}\0${stream.join('\0')}`, leaf)
  }
  const cuts = new Map<Leaf, Cut[]>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const starts: number[] = []
    let text = ''
    for (const leaf of group) {
      starts.push(text.length)
      text += leaf.value
    }
    for (const m of findSecrets(text, env)) {
      const spanned = group.flatMap((leaf, i) => {
        const from = starts[i] as number
        const start = Math.max(m.start, from)
        const end = Math.min(m.end, from + leaf.value.length)
        return start < end ? [{ leaf, start: start - from, end: end - from }] : []
      })
      if (spanned.length < 2) continue
      spanned.forEach(({ leaf, start, end }, i) => {
        const list = cuts.get(leaf)
        const cut = { start, end, lead: i === 0 }
        if (list) list.push(cut)
        else cuts.set(leaf, [cut])
      })
    }
  }
  if (cuts.size === 0) return [...lines]
  const out = [...lines]
  const changed = new Set<number>()
  for (const [leaf, list] of cuts) {
    const masked = cutLeaf(leaf.value, list)
    const last = leaf.path.at(-1)
    if (last === undefined) parsed[leaf.line] = { ok: true, value: masked }
    else parentOf(leaf)[last] = masked
    changed.add(leaf.line)
  }
  for (const i of changed) out[i] = JSON.stringify((parsed[i] as { value: unknown }).value)
  return out
}

/** How many stretches `redactSecrets` would mask. */
export const countSecrets = (text: string, env: NodeJS.ProcessEnv = process.env): number =>
  findSecrets(text, env).length

/**
 * A found secret as it can be shown: a variable's value never, a credential shape by its first
 * and last four characters.
 */
export function maskedMatch(text: string, match: SecretMatch): string {
  if (match.known) return match.rule
  const value = text.slice(match.start, match.end)
  const shown =
    value.length >= 16 ? `${value.slice(0, 4)}…${value.slice(-4)}` : `${value.slice(0, 2)}…`
  return `${match.rule} (${shown})`
}

/** Drops `user:password@` from a URL so it can be recorded or shown. */
export const stripCredentials = (url: string) =>
  url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1')
