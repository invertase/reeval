const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

/** Masks the values of secret-looking environment variables anywhere in `text`. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const secrets = Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && value && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length)
  let out = text
  for (const secret of secrets) {
    out = out.replaceAll(secret, '[REDACTED]')
    // Also catch the value as it appears inside JSON strings.
    const escaped = JSON.stringify(secret).slice(1, -1)
    if (escaped !== secret) out = out.replaceAll(escaped, '[REDACTED]')
  }
  return out
}
