import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const leaky = defineEnvironment('leaky', ({ secret }) => ({
  sandbox,
  env: { LEAKY_TOKEN: secret.fromEnv('REEVAL_FIXTURE_LEAKY') },
}))

/** The forms the scripted agent prints: raw, base64, URL-encoded and JSON-escaped. */
export const forms = (v: string) => [
  v,
  Buffer.from(v).toString('base64'),
  encodeURIComponent(v),
  JSON.stringify(v).slice(1, -1),
]
