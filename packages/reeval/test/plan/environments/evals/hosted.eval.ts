import { defineEnvironment, evaluate } from 'reeval'
import { cursor, fakeHarness } from 'reeval/harness'
import { hosted } from 'reeval/sandbox/hosted'

const small = defineEnvironment('small', { sandbox: hosted(), egress: 'allow-all' })
const medium = defineEnvironment('medium', {
  sandbox: hosted({ size: 'medium' }),
  egress: 'allow-all',
})
const shared = defineEnvironment('shared', {
  sandbox: hosted({ size: 'large', reuse: true, attemptsPerMachine: 2, maxConcurrent: 4 }),
  egress: 'allow-all',
})

evaluate('hosted', { environments: small }, async () => {})
evaluate('hosted medium', { environments: medium }, async () => {})
evaluate(
  'hosted shared',
  { environments: shared, harnesses: fakeHarness(), runs: 2 },
  async () => {},
)
evaluate(
  'hosted on a real harness',
  { environments: small, harnesses: cursor({ model: 'composer-2.5' }) },
  async () => {},
)
