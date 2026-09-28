import { DEFAULT_EGRESS_ALLOW, defineEnvironment, evaluate, group } from 'reeval'
import { fakeHarness } from 'reeval/harness'

const closed = defineEnvironment('closed', { egress: 'deny-all' })
const reopened = closed.extend('reopened', { egress: 'allow-all' })
const installs = defineEnvironment('installs', {
  egress: { allow: [...DEFAULT_EGRESS_ALLOW, 'api.example.com'] },
})
const plain = defineEnvironment('plain', {})

evaluate('the config policy', async () => {})
evaluate('an environment replaces it', { environment: closed }, async () => {})
evaluate('an extend child replaces its parent', { environment: reopened }, async () => {})
evaluate('the default list spreads', { environment: installs }, async () => {})
evaluate(
  'the eval replaces the environment',
  { environment: closed, egress: { allow: ['eval.example.com'] } },
  async () => {},
)
group('a group', { egress: { allow: ['group.example.com'] } }, () => {
  evaluate('replaces the environment too', { environment: closed }, async () => {})
})
evaluate(
  'a variant runs under its own policy',
  { environment: plain, compare: { variants: [closed] } },
  async () => {},
)
evaluate(
  "a fake agent with a layout gets that agent's hosts",
  { environment: closed, harness: fakeHarness({ layout: 'claude-code' }) },
  async () => {},
)
