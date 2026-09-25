import { defineEnvironment } from 'evalsuite'

export const keys = defineEnvironment('keys', ({ secret }) => ({
  env: {
    CHECK_TOKEN: secret.fromEnv('ES_FIXTURE_TOKEN', { to: 'checks', hosts: ['api.example.com'] }),
  },
}))
