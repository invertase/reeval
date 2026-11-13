/** What a masked value reads as. */
export const REDACTED = '[REDACTED]'

export const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

/** Where a value has its first whitespace or control character, from 1; 0 when it has none. */
export const badCharacterAt = (value: string) =>
  [...value].findIndex((c) => /[\s\p{Cc}]/u.test(c)) + 1

/**
 * Well-known credential shapes, masked even when they aren't in this process's environment.
 * Distinctive prefixes match after any character (`TOKEN_ghp_…`, `key%3Dghp_…`). A prefix that
 * ordinary words share (`task-…`, `ASIAN…`) has `word`, the characters it may not follow.
 */
const TOKEN_SHAPES: Array<{ rule: string; prefix: string; rest: string; word?: string }> = [
  { rule: 'Google API key', prefix: 'AIza', rest: '[0-9A-Za-z_-]{35}' },
  {
    rule: 'OpenAI or Anthropic key',
    prefix: 'sk-',
    rest: '(?:ant-|proj-)?[A-Za-z0-9_-]{20,}',
    word: 'A-Za-z0-9',
  },
  { rule: 'GitHub token', prefix: '(?:ghp|gho|ghu|ghs|ghr)_', rest: '[A-Za-z0-9]{36,}' },
  { rule: 'GitHub token', prefix: 'github_pat_', rest: '[A-Za-z0-9_]{22,}' },
  {
    rule: 'AWS access key',
    prefix: '(?:AKIA|ASIA)',
    rest: '[0-9A-Z]{16}(?![0-9A-Za-z])',
    word: '0-9A-Z',
  },
  { rule: 'Slack token', prefix: 'xox[abprs]-', rest: '[A-Za-z0-9-]{10,}' },
  { rule: 'Slack token', prefix: 'xapp-', rest: '\\d-[A-Za-z0-9-]{40,}' },
  { rule: 'xAI API key', prefix: 'xai-', rest: '[A-Za-z0-9_]{40,}', word: 'A-Za-z0-9' },
  { rule: 'Vercel token', prefix: 'vc[kpiar]_', rest: '[A-Za-z0-9]{24,}', word: 'A-Za-z0-9' },
  { rule: 'Groq API key', prefix: 'gsk_', rest: '[A-Za-z0-9]{40,}', word: 'A-Za-z0-9' },
  { rule: 'Perplexity API key', prefix: 'pplx-', rest: '[A-Za-z0-9]{32,}', word: 'A-Za-z0-9' },
  { rule: 'Hugging Face token', prefix: 'hf_', rest: '[A-Za-z0-9]{34,}', word: 'A-Za-z0-9' },
  {
    rule: 'GitLab token',
    prefix: 'glpat-',
    rest: '[A-Za-z0-9_-]{20,}(?:(?:\\.[0-9a-z]{2})?\\.[0-9a-z]{9})?',
  },
  {
    rule: 'Stripe key',
    prefix: '[rs]k_(?:live|test)_',
    rest: '[A-Za-z0-9]{24,}',
    word: 'A-Za-z0-9',
  },
  { rule: 'npm token', prefix: 'npm_', rest: '[A-Za-z0-9]{36,}', word: 'A-Za-z0-9' },
  {
    rule: 'PyPI token',
    prefix: 'pypi-AgE(?:IcHlwaS5vcmc|NdGVzdC5weXBpLm9yZw)',
    rest: '[A-Za-z0-9_-]{50,}',
  },
  // `ya29.c.` and `ya29.d.` tokens have more dots after the prefix; the last character isn't
  // one, so a full stop after a token stays.
  {
    rule: 'Google OAuth token',
    prefix: 'ya29\\.',
    rest: '[A-Za-z0-9_.-]{30,}(?<!\\.)',
  },
  { rule: 'Google OAuth client secret', prefix: 'GOCSPX-', rest: '[A-Za-z0-9_-]{28,}' },
  {
    rule: 'JWT',
    prefix: 'eyJ',
    rest: '[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',

    // Base64 of JSON holds `eyJ` wherever a `{"` lines up: unguarded, each one would scan to the
    // end of the run.
    word: 'A-Za-z0-9',
  },
  {
    rule: 'private key',
    prefix: '-----BEGIN ',
    rest: '[A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----',
  },
]

/**
 * After `prefix`, so the search still scans for the prefix first: it follows none of `word`'s
 * characters, or follows an escape that may stand for any character (`%3D`, `\n`, `\u003d`).
 */
const follows = (prefix: string, word: string) =>
  `(?<=(?:^|[^${word}]|%[0-9A-Fa-f]{2}|\\\\[nrtbf]|\\\\u[0-9A-Fa-f]{4})${prefix})`

const TOKEN_PATTERNS = TOKEN_SHAPES.map(({ rule, prefix, rest, word }) => ({
  rule,
  pattern: new RegExp(`${prefix}${word ? follows(prefix, word) : ''}${rest}`, 'g'),
}))

/** The guarded token shapes, matched exactly where they're asked to start, whatever is before. */
const TOKEN_AFTER = TOKEN_SHAPES.filter(({ word }) => word).map(({ rule, prefix, rest }) => ({
  rule,
  pattern: new RegExp(`${prefix}${rest}`, 'y'),
}))

/** Whether a value holds a well-known credential shape. */
export const hasTokenShape = (value: string) =>
  TOKEN_PATTERNS.some(({ pattern }) => value.search(pattern) !== -1)

/** Values declared with `secret()`, masked whatever their variable is called. */
const declaredSecrets = new Set<string>()

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 4 && !isPlaceholder(value)) declaredSecrets.add(value)
}

/** Variables reeval set in the sandbox itself (`c.exec`'s `env`), masked as host variables are. */
const sandboxVariables = new Map<string, string>()

/** Masks `value` from now on when `name` looks like a secret's, by the rules a host variable's follows. */
export function registerVariable(name: string, value: string): void {
  if (SECRET_NAME.test(name) && value.length >= 8) sandboxVariables.set(value, name)
}

/**
 * Registers each string in `c.exec`'s `env` as `registerVariable` does, whatever else it holds:
 * called before the options are checked, so a refusal that quotes a value masks a secret's.
 */
export function registerExecEnv(env: unknown): void {
  if (!env || typeof env !== 'object') return
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string') registerVariable(name, value)
  }
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
 * plain-text redaction read serialized JSON, and a JSON string can hold JSON the agent printed.
 */
const formsOf = (value: string) => {
  let forms = formsCache.get(value)
  if (!forms) {
    forms = [...new Set([value, ...encodedForms(value)].flatMap((f) => [f, jsonEscaped(f)]))]
    formsCache.set(value, forms)
  }
  return forms
}

/**
 * A brokered secret's placeholder, which a held secret's variable is set to: no secret, and its
 * windows would mask every other placeholder's prefix.
 */
const PLACEHOLDER = /^reeval_secret_[0-9A-Za-z]{32}$/

export const isPlaceholder = (value: string | undefined) => !!value && PLACEHOLDER.test(value)

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
 * match the structure of serialized JSON (`","sha256":"`) and break the record around them.
 */
const STRUCTURAL = /["'\\,:{}[\]\s]/

type Secrets = {
  /** Whole values and their encoded forms, longest first. */
  forms: string[]
  /**
   * The forms masked in a JSON key that reads as a field name, or a string that reads as a
   * digest: those of `MIN_FRAGMENT` or more characters, so a short declared secret (`error`,
   * `1234`) can't rename a record's fields or break its hashes.
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

const OTLP_HEADERS = /^OTEL_EXPORTER_OTLP_(?:(?:TRACES|LOGS|METRICS)_)?HEADERS$/i
const AUTH_SCHEME = /^(?:Bearer|Basic|Token|Api-?Key)(?: |%20)+(\S.*)$/i

/**
 * Every value in the OTLP exporter's header variables, raw and decoded, whatever its header is
 * called: a collector's key goes in headers such as `x-honeycomb-team`, which no name rule knows.
 * The credential after an auth scheme (`Bearer <token>`) is a value of its own, since it appears
 * without the scheme too.
 */
function otlpHeaderValues(env: NodeJS.ProcessEnv): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [name, text] of Object.entries(env)) {
    if (!text || !OTLP_HEADERS.test(name)) continue
    for (const part of text.split(',')) {
      const raw = part.slice(part.indexOf('=') + 1).trim()
      if (!part.includes('=') || raw.length < 4) continue
      let decoded = raw
      try {
        decoded = decodeURIComponent(raw)
      } catch {}
      for (const value of new Set([raw, decoded])) {
        out.push([value, name])
        const token = AUTH_SCHEME.exec(value)?.[1]?.trim()
        if (token && token.length >= 4) out.push([token, name])
      }
    }
  }
  return out
}

function envSecrets(env: NodeJS.ProcessEnv, also: readonly string[] = []): Secrets {
  const rules = new Map<string, string>()
  for (const [name, value] of Object.entries(env)) {
    if (
      SECRET_NAME.test(name) &&
      value &&
      value.length >= 8 &&
      !isPlaceholder(value) &&
      !rules.has(value)
    ) {
      rules.set(value, valueRule(name))
    }
  }
  for (const [value, name] of sandboxVariables) {
    if (!rules.has(value)) rules.set(value, valueRule(name))
  }
  for (const [value, name] of otlpHeaderValues(env)) {
    if (!rules.has(value)) rules.set(value, valueRule(name))
  }
  const declared = also.length
    ? new Set([...declaredSecrets, ...also.filter((v) => v.length >= 4)])
    : declaredSecrets
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

type Range = { start: number; end: number; rule: string; known: boolean }

/**
 * Every stretch of `text` to mask, in order, with overlapping ones merged: each of `forms`, each
 * stretch of fragments and each token shape, all found in `text` as it is. Masking one before
 * looking for the others would cut into them: a fragment of one key inside a second key that
 * shares its `sk-ant-api03-` breaks the second's shape, and a token running on into a password
 * leaves the rest of the password. A token shape may also start right where a known stretch
 * ends, word boundary or not, as it would once that stretch reads `[REDACTED]`. A merged stretch
 * is `known` when any part is, and takes the rule of the stretch starting first (the longer on a
 * tie, else the known one).
 */
function secretRanges(text: string, secrets: Secrets, forms = secrets.forms): Range[] {
  if (text.length < secrets.shortest) return []
  const found: Range[] = []
  for (const form of forms) {
    const rule = secrets.formRules.get(form) as string
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + form.length)) {
      found.push({ start: at, end: at + form.length, rule, known: true })
    }
  }
  for (const [start, end, rule] of fragmentRanges(text, secrets)) {
    found.push({ start, end, rule, known: true })
  }
  const ends = new Set(found.map((r) => r.end))
  for (const { rule, pattern } of TOKEN_PATTERNS) {
    // A token can start inside the one before it and run past its end (`ghp_…ghp_…`, whose first
    // match takes the second's `ghp`), so each search after a match starts one character into it.
    // One that ends no later than the match ends the search there, which keeps the scan linear.
    let last = -1
    pattern.lastIndex = 0
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      const end = m.index + m[0].length
      if (end <= last) {
        pattern.lastIndex = last
        continue
      }
      found.push({ start: m.index, end, rule, known: false })
      last = end
      pattern.lastIndex = m.index + 1
    }
  }
  for (const end of ends) {
    for (const { rule, pattern } of TOKEN_AFTER) {
      pattern.lastIndex = end
      const m = pattern.exec(text)
      if (m) found.push({ start: end, end: end + m[0].length, rule, known: false })
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end || Number(b.known) - Number(a.known))
  const merged: Range[] = []
  for (const range of found) {
    const last = merged.at(-1)
    if (last && range.start < last.end) {
      last.end = Math.max(last.end, range.end)
      last.known ||= range.known
    } else merged.push({ ...range })
  }
  return merged
}

/**
 * Masks well-known token shapes, the values of secret-looking environment variables and declared
 * secrets, raw or JSON-, URL- or base64-encoded, and any stretch of `MIN_FRAGMENT` or more of
 * their characters, anywhere in `text`.
 */
export const redactSecrets = (text: string, env: NodeJS.ProcessEnv = process.env): string =>
  redactWith(text, envSecrets(env))

function redactWith(text: string, secrets: Secrets, forms = secrets.forms): string {
  const ranges = secretRanges(text, secrets, forms)
  if (ranges.length === 0) return text
  let out = ''
  let at = 0
  for (const { start, end } of ranges) {
    out += `${text.slice(at, start)}${REDACTED}`
    at = end
  }
  return out + text.slice(at)
}

/** `o` with each of its string fields masked, but those named in `keep`. */
export function redactFields<T extends object>(o: T, keep: ReadonlyArray<string> = []): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    out[k] = typeof v === 'string' && !keep.includes(k) ? redactSecrets(v) : v
  }
  return out as T
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
 * Serialized JSON or JSON Lines with every string literal (object keys included) passed through
 * `map`, and the text kept byte for byte outside the ones it changes, so `null`, numbers and
 * booleans stay as they are. A line that isn't JSON goes through `map` whole, as a value.
 */
export function mapJsonStrings(text: string, map: (value: string, key: boolean) => string): string {
  const chunks = jsonChunks(text)
  const mapped = chunks.map((c) => (c.json ? mapLiterals(c.text, map) : map(c.text, false)))
  return text.slice(0, chunks[0]?.at ?? 0) + mapped.join('\n')
}

const FIELD_NAME = /^[A-Za-z_$][\w$]*$/

/** A commit or sha256 digest: a hash of masked text, so a short secret inside it is chance. */
const DIGEST = /^(?:sha256:)?(?:[0-9a-f]{40}|[0-9a-f]{64})$/

const redactLiteral = (secrets: Secrets) => (value: string, key: boolean) =>
  redactWith(
    value,
    secrets,
    (key && FIELD_NAME.test(value)) || DIGEST.test(value) ? secrets.keyForms : secrets.forms,
  )

/**
 * `value` serialized (`JSON.stringify(value, null, space)`), with secrets masked as
 * `redactSecrets` masks them but only inside its strings: the result is valid JSON of the same
 * shape, and `null`, numbers and booleans stay as they are whatever the secrets are, so a secret
 * held as a number isn't masked. In a key that reads as a field name (`durationMs`), and in a
 * string that reads as a commit or sha256 digest, only forms of `MIN_FRAGMENT` or more characters
 * are masked; other keys (paths, header names) are masked as values are.
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

/** What loupe, chai and pretty-format call to format a value instead of reading its fields. */
const FORMAT_HOOKS: PropertyKey[] = [
  'inspect',
  'toJSON',
  Symbol.for('chai/inspect'),
  Symbol.for('nodejs.util.inspect.custom'),
]

const hasHook = (v: object, key: PropertyKey) =>
  typeof (v as Record<PropertyKey, unknown>)[key] === 'function'

/**
 * Whether a copy of `v` on its own prototype formats as `v` does: a plain object, an error or a
 * class instance, read field by field. A copy has none of `v`'s private (`#`) fields, so one with a
 * format hook, which could read them, isn't copied; nor are built-ins with internal slots (dates,
 * promises, buffers), whose tag isn't an object's or an error's. An error's `toJSON` doesn't count:
 * loupe formats an error from its fields alone, and the copy's `toJSON` is the original's.
 */
function copyable(v: object, proto: unknown): boolean {
  if (proto === Object.prototype || proto === null) return true
  const tag = Object.prototype.toString.call(v)
  if (tag === '[object Error]') return !FORMAT_HOOKS.some((k) => k !== 'toJSON' && hasHook(v, k))
  return tag === '[object Object]' && !FORMAT_HOOKS.some((key) => hasHook(v, key))
}

/**
 * `value` with every string in it masked as `redactSecrets` masks text, keeping its shape: arrays,
 * Maps, Sets, and plain objects, errors and class instances on their own prototype, with their
 * property flags. What a failed assertion's message and diff are made from, since both shorten or
 * split a value, which leaves a secret in them that masking the text afterwards no longer
 * recognizes. A value with no secret in it is returned as it is; so is one `copyable` refuses,
 * left to the masking of the formatted text.
 */
export function redactStrings<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  const secrets = envSecrets(env)
  const seen = new Map<object, unknown>()
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactWith(v, secrets)
    if (typeof v !== 'object' || v === null) return v
    if (seen.has(v)) return seen.get(v)
    seen.set(v, v)
    let out: unknown = v
    const proto: unknown = Object.getPrototypeOf(v)
    if (proto === Array.prototype) {
      const list = v as unknown[]
      const items = list.map(walk)
      if (items.some((item, i) => item !== list[i])) out = items
    } else if (proto === Map.prototype) {
      const entries = [...(v as Map<unknown, unknown>)]
      const masked = entries.map(([k, x]) => [walk(k), walk(x)] as const)
      if (masked.some(([k, x], i) => k !== entries[i]?.[0] || x !== entries[i]?.[1]))
        out = new Map(masked)
    } else if (proto === Set.prototype) {
      const items = [...(v as Set<unknown>)]
      const masked = items.map(walk)
      if (masked.some((item, i) => item !== items[i])) out = new Set(masked)
    } else if (copyable(v, proto)) {
      const error = v instanceof Error
      const descriptors = Object.getOwnPropertyDescriptors(v) as Record<
        PropertyKey,
        PropertyDescriptor
      >
      // An error's `stack` is an accessor that reads only on the error it was made for.
      if (error) descriptors.stack = { value: v.stack, writable: true, configurable: true }
      let changed = false
      for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key] as PropertyDescriptor
        if (!('value' in descriptor)) continue
        const masked = walk(descriptor.value)
        if (masked !== descriptor.value) {
          descriptor.value = masked
          changed = true
        }
      }
      if (changed) {
        // pretty-format diffs what `toJSON` returns, which the original makes from its own fields;
        // on a prototype between, since loupe lists every own property of an error.
        const base =
          error && hasHook(v, 'toJSON')
            ? Object.create(proto as object, {
                toJSON: {
                  value: () => redactStrings((v as unknown as { toJSON(): unknown }).toJSON(), env),
                  configurable: true,
                  writable: true,
                },
              })
            : proto
        out = Object.defineProperties(
          error
            ? Object.setPrototypeOf(new Error(), base as object)
            : Object.create(proto as object | null),
          descriptors,
        )
      }
    }
    seen.set(v, out)
    return out
  }
  return walk(value) as T
}

/**
 * Serialized JSON or JSON Lines, masked as `redactJson` masks a value, with the text kept byte
 * for byte outside the strings it masks. A line that isn't JSON is masked as plain text. `also`
 * are masked as declared secrets are, without declaring them for the rest of the process.
 */
export const redactJsonText = (
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  also: readonly string[] = [],
): string => mapJsonStrings(text, redactLiteral(envSecrets(env, also)))

/** A JSON object key masked as `redactJson` masks one. */
export const redactKey = (key: string, env: NodeJS.ProcessEnv = process.env): string =>
  redactLiteral(envSecrets(env))(key, true)

/** One stretch `redactSecrets` would mask: where it is in the text, and why. */
export type SecretMatch = {
  start: number
  end: number
  /** `the value of NAME`, `a declared secret`, or a credential shape such as `Google API key`. */
  rule: string
  /**
   * Whether some part of the stretch is a variable's value, a declared secret or a fragment of
   * one, so no part of it may be shown. `rule` may still name a credential shape, when the known
   * part is inside one.
   */
  known: boolean
}

/** What `redactSecrets` would mask, in order. Used as a last check before anything leaves the machine. */
export const findSecrets = (text: string, env: NodeJS.ProcessEnv = process.env): SecretMatch[] =>
  secretRanges(text, envSecrets(env))

/** The variables whose values `redactSecrets` masks in `text`, by name, each once. */
export const maskedVariables = (text: string, env: NodeJS.ProcessEnv = process.env): string[] => [
  ...new Set(
    findSecrets(text, env).flatMap(({ rule }) =>
      rule.startsWith(valueRule('')) ? [rule.slice(valueRule('').length)] : [],
    ),
  ),
]

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
 * What `redactJsonText` would mask in serialized JSON or JSON Lines: `findSecrets`' matches inside
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
 * and last four characters unless it holds a known part.
 */
export function maskedMatch(text: string, match: SecretMatch): string {
  if (match.known) return match.rule
  const value = text.slice(match.start, match.end)
  const shown =
    value.length >= 16 ? `${value.slice(0, 4)}…${value.slice(-4)}` : `${value.slice(0, 2)}…`
  return `${match.rule} (${shown})`
}

/**
 * Drops `user:password@` from a URL so it can be recorded or shown. The password may
 * contain `@`, or a `/` that keeps the string from parsing; the whole userinfo goes.
 * A numeric port (`host:443/path`) stays.
 */
export function stripCredentials(url: string): string {
  const parsed = URL.parse(url)
  if (parsed && (parsed.username || parsed.password)) {
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url)
    if (scheme) {
      const rest = url.slice(scheme[0].length)
      const cut = rest.search(/[/?#]/)
      const authority = cut === -1 ? rest : rest.slice(0, cut)
      const at = authority.toLowerCase().lastIndexOf(`@${parsed.host.toLowerCase()}`)
      if (at !== -1) return scheme[0] + rest.slice(at + 1)
    }
  }
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*:(?!\d+(?:[/?#]|$))[^?#]*@/i, '$1')
}
