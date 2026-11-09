import { defineEnvironment, evaluate } from 'reeval'
import { cursor, fakeHarness } from 'reeval/harness'
import { cloud } from 'reeval/internal/vm'

const small = defineEnvironment('small', { sandbox: cloud(), egress: 'allow-all' })
const medium = defineEnvironment('medium', {
  sandbox: cloud({ size: 'medium' }),
  egress: 'allow-all',
})
const shared = defineEnvironment('shared', {
  sandbox: cloud({ size: 'large', reuse: true, attemptsPerMachine: 2, maxConcurrent: 4 }),
  egress: 'allow-all',
})

evaluate('cloud', { environments: small }, async () => {})
evaluate('cloud medium', { environments: medium }, async () => {})
evaluate(
  'cloud shared',
  { environments: shared, harnesses: fakeHarness(), runs: 2 },
  async () => {},
)
evaluate(
  'cloud on a real harness',
  { environments: small, harnesses: cursor({ model: 'composer-2.5' }) },
  async () => {},
)
