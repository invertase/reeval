import { defineEnvironment } from 'evalsuite'

export const tokens = defineEnvironment('tokens', ({ secret }) => ({
  env: { CHECK_TOKEN: secret.fromEnv('ES_FIXTURE_TOKEN', { to: 'checks' }) },
}))
