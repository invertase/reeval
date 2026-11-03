import { defineEnvironment, evaluate } from 'reeval'

const plain = defineEnvironment('plain-env', ({ mcp }) => ({
  env: { UPSTREAM: 'ghp_0123456789abcdefghijABCDEFGHIJ0123456789', NODE_ENV: 'test' },
  mcp: {
    db: mcp.stdio('npx', ['-y', 'db-server'], {
      env: { DB_PASSWORD: 'hunter2-hunter2', MAX_TOKENS: '4096', DB_HOST: 'localhost' },
    }),
  },
}))

evaluate('plain env strings that look like credentials', { environments: plain }, async () => {})
evaluate(
  'a token in the eval env',
  { env: { SLACK: 'xoxb-0123456789-abcdefghij' } },
  async () => {},
)
