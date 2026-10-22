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
 * The value and its encoded forms, each also as it reads inside a JSON string: redaction runs on
 * serialised records, where a JSON-escaped form the agent printed is escaped a second time.
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
  const secrets = { forms, formRules, windows, starts }
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
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const secrets = envSecrets(env)
  let out = text
  for (const secret of secrets.forms) out = out.replaceAll(secret, REDACTED)
  out = maskFragments(out, secrets)
  for (const { pattern } of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED)
  return out
}

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
