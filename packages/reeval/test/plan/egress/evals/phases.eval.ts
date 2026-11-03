import { defineEnvironment, evaluate, group } from 'reeval'
import { fakeHarness } from 'reeval/harness'

const phased = defineEnvironment('phased', { egress: { setup: 'allow-all', agent: 'deny-all' } })
const setupOnly = defineEnvironment('setup-only', { egress: { setup: 'allow-all' } })
const closed = defineEnvironment('closed', { egress: 'deny-all' })
const reopened = closed.extendEnvironment('reopened', { egress: { setup: 'allow-all' } })
const same = defineEnvironment('same', { egress: { setup: 'deny-all', agent: 'deny-all' } })

evaluate('an environment sets each phase', { environments: phased }, async () => {})
evaluate('an unset phase keeps the config policy', { environments: setupOnly }, async () => {})
evaluate(
  'a plain policy on the eval replaces both phases',
  { environments: phased, egress: 'deny-all' },
  async () => {},
)
evaluate(
  'a phase on the eval replaces only that phase',
  { environments: phased, egress: { agent: { allow: ['eval.example.com'] } } },
  async () => {},
)
group('a group sets setup', { egress: { setup: 'allow-all' } }, () => {
  evaluate('and the eval the agent', { egress: { agent: 'deny-all' } }, async () => {})
})
evaluate('an extend child sets setup over its parent', { environments: reopened }, async () => {})
evaluate('equal phases are one policy', { environments: same }, async () => {})
evaluate(
  'a variant changes only setup',
  { compare: { control: closed, variants: [reopened] } },
  async () => {},
)
evaluate(
  'each restricted phase gets the automatic hosts',
  {
    environments: closed,
    egress: { setup: { allow: ['registry.npmjs.org'] } },
    harnesses: fakeHarness({ layout: 'claude-code' }),
  },
  async () => {},
)
