import { defineEnvironment } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'

export const keys = defineEnvironment('keys', ({ secret }) => ({
  sandbox: fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) }),
  env: { API_KEY: secret.fromEnv('API_KEY') },
}))
