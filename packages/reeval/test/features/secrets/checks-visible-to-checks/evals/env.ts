import { defineEnvironment } from 'reeval'

export const tokens = defineEnvironment('tokens', ({ secret }) => ({
  env: { CHECK_TOKEN: secret.fromEnv('REEVAL_FIXTURE_TOKEN', { to: 'checks' }) },
}))
