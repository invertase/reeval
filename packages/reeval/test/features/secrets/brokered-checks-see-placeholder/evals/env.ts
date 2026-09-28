import { defineEnvironment } from 'reeval'

export const keys = defineEnvironment('keys', ({ secret }) => ({
  env: {
    CHECK_TOKEN: secret.fromEnv('REEVAL_FIXTURE_TOKEN', {
      to: 'checks',
      hosts: ['api.example.com'],
    }),
  },
}))
