import { evaluate, group } from 'evalsuite'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// Two evals inherit the config's sandbox: one warning, naming the config.
evaluate('pings a host', async () => {})
evaluate('traces a route', async () => {})

// Two evals inherit the group's: one warning, naming the group.
group('system packages', { sandbox: docker({ root: true }) }, () => {
  evaluate('installs jq', async () => {})
  evaluate('installs curl', async () => {})
})

// Root and a capability on the eval itself: a warning for each.
evaluate(
  'installs deps',
  { sandbox: docker({ root: true, capabilities: ['NET_ADMIN'] }) },
  async () => {},
)

// No warning: the default docker() and the fake sandbox.
evaluate('stays unprivileged', { sandbox: docker() }, async () => {})
evaluate('on the fake sandbox', { sandbox: fakeSandbox() }, async () => {})
