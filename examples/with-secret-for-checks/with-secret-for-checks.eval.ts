import { defineEnvironment, evaluate, expect } from 'reeval'

// to: 'checks' gives the token to c.exec and setup steps only. optional: true runs the eval
// without it, leaving the variable out.
const e2e = defineEnvironment('e2e', ({ secret }) => ({
  env: { E2E_TOKEN: secret.fromEnv('E2E_TOKEN', { to: 'checks', optional: true }) },
}))

evaluate('keeps the test token from the agent', { environment: e2e }, async (c) => {
  await c.send('Run `env | sort > env.txt`, then reply with how many lines env.txt has.')

  expect(await c.readFile('env.txt'), "the agent's env").not.toMatch(/^E2E_TOKEN=/m)
  const token = await c.exec('printenv E2E_TOKEN')
  expect(token.exitCode, 'the checks get the token').toBe(process.env.E2E_TOKEN ? 0 : 1)
})
