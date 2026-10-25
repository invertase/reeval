import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// Declared secrets that read as JSON values once serialised: `null` and a short number.
export const pins = defineEnvironment('pins', ({ secret }) => ({
  sandbox,
  env: {
    PIN: secret.fromEnv('REEVAL_FIXTURE_PIN'),
    PLACEHOLDER: secret.fromEnv('REEVAL_FIXTURE_PLACEHOLDER'),
  },
}))
