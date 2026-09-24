const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

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

function envSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && value && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length)
}

/**
 * Masks the values of secret-looking environment variables, and well-known token shapes,
 * anywhere in `text`.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text
  for (const secret of envSecrets(env)) {
    out = out.replaceAll(secret, '[REDACTED]')
    // Also catch the value as it appears inside JSON strings.
    const escaped = JSON.stringify(secret).slice(1, -1)
    if (escaped !== secret) out = out.replaceAll(escaped, '[REDACTED]')
  }
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
