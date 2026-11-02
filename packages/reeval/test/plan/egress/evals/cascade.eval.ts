import { DEFAULT_EGRESS_ALLOW, defineEnvironment, evaluate, group } from 'reeval'
import { fakeHarness } from 'reeval/harness'

const closed = defineEnvironment('closed', { egress: 'deny-all' })
const reopened = closed.extendEnvironment('reopened', { egress: 'allow-all' })
const installs = defineEnvironment('installs', {
  egress: { allow: [...DEFAULT_EGRESS_ALLOW, 'api.example.com'] },
})
const plain = defineEnvironment('plain', {})

evaluate('the config policy', async () => {})
evaluate('an environment replaces it', { environments: closed }, async () => {})
evaluate('an extend child replaces its parent', { environments: reopened }, async () => {})
evaluate('the default list spreads', { environments: installs }, async () => {})
evaluate(
  'the eval replaces the environment',
  { environments: closed, egress: { allow: ['eval.example.com'] } },
  async () => {},
)
group('a group', { egress: { allow: ['group.example.com'] } }, () => {
  evaluate('replaces the environment too', { environments: closed }, async () => {})
})
evaluate(
  'a variant runs under its own policy',
  { compare: { control: plain, variants: [closed] } },
  async () => {},
)
evaluate(
  "a fake agent with a layout gets that agent's hosts",
  { environments: closed, harnesses: fakeHarness({ layout: 'claude-code' }) },
  async () => {},
)
