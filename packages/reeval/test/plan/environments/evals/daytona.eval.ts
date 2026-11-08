import { defineEnvironment, evaluate } from 'reeval'
import { claudeCode, cursor, fakeHarness } from 'reeval/harness'
import { createDaytona, daytona } from 'reeval/sandbox/daytona'

const medium = defineEnvironment('medium', { sandbox: daytona(), egress: 'allow-all' })
const large = defineEnvironment('large', {
  sandbox: daytona({ size: 'large' }),
  egress: 'allow-all',
})
const team = defineEnvironment('team', {
  sandbox: createDaytona({ prefix: 'team' })(),
  egress: 'allow-all',
})
const shared = defineEnvironment('shared', {
  sandbox: daytona({ size: 'small', reuse: true, attemptsPerMachine: 2, maxConcurrent: 4 }),
  egress: 'allow-all',
})

evaluate('daytona', { environments: medium }, async () => {})
evaluate('daytona large', { environments: large }, async () => {})
evaluate('daytona on a team prefix', { environments: team }, async () => {})
evaluate(
  'daytona shared',
  { environments: shared, harnesses: fakeHarness(), runs: 2 },
  async () => {},
)
evaluate(
  'daytona on real harnesses',
  {
    environments: medium,
    harnesses: [cursor({ model: 'composer-2.5' }), claudeCode({ model: 'claude-sonnet-5' })],
  },
  async () => {},
)
