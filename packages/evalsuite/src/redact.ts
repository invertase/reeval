export const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

/** Well-known credential shapes, masked even when they aren't in this process's environment. */
const TOKEN_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{35}/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

/** Values declared with `secret()`, masked whatever their variable is called. */
const declared = new Set<string>()

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 4) declared.add(value)
}

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

function envSecrets(env: NodeJS.ProcessEnv): string[] {
  const named = Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && value && value.length >= 8)
    .map(([, value]) => value as string)
  const values = [...new Set([...named, ...declared])]
  return [...new Set(values.flatMap(formsOf))].sort((a, b) => b.length - a.length)
}

/**
 * Masks the values of secret-looking environment variables and declared secrets, raw or
 * JSON-, URL- or base64-encoded, and well-known token shapes, anywhere in `text`.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text
  for (const secret of envSecrets(env)) out = out.replaceAll(secret, '[REDACTED]')
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, '[REDACTED]')
  return out
}

/** Counts what `redactSecrets` would mask. Used as a last check before anything leaves the machine. */
export function countSecrets(text: string, env: NodeJS.ProcessEnv = process.env): number {
  let count = 0
  for (const secret of envSecrets(env)) count += text.split(secret).length - 1
  for (const pattern of TOKEN_PATTERNS) count += text.match(pattern)?.length ?? 0
  return count
}

/** Drops `user:password@` from a URL so it can be recorded or shown. */
export const stripCredentials = (url: string) =>
  url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1')
