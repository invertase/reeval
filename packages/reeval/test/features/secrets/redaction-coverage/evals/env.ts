import { defineEnvironment } from 'reeval'

export const leaky = defineEnvironment('leaky', ({ secret }) => ({
  env: { LEAKY_TOKEN: secret.fromEnv('REEVAL_FIXTURE_LEAKY') },
}))

/** The forms the scripted agent prints: raw, base64, URL-encoded and JSON-escaped. */
export const forms = (v: string) => [
  v,
  Buffer.from(v).toString('base64'),
  encodeURIComponent(v),
  JSON.stringify(v).slice(1, -1),
]
