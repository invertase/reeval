import { defineEnvironment, evaluate, group } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const pkgs = defineEnvironment('pkgs', { sandbox: docker({ root: true }) })
const deps = defineEnvironment('deps', {
  sandbox: docker({ root: true, capabilities: ['NET_ADMIN'] }),
})
const plain = defineEnvironment('plain', { sandbox: docker() })
const host = defineEnvironment('host', { sandbox: fakeSandbox() })

// Two evals inherit the config's environment: one warning, naming the config.
evaluate('pings a host', async () => {})
evaluate('traces a route', async () => {})

// Two evals inherit the group's: one warning, naming the group.
group('system packages', { environment: pkgs }, () => {
  evaluate('installs jq', async () => {})
  evaluate('installs curl', async () => {})
})

// Root and a capability on the eval's environment: a warning for each.
evaluate('installs deps', { environment: deps }, async () => {})

// No warning: a default docker() environment and the fake sandbox.
evaluate('stays unprivileged', { environment: plain }, async () => {})
evaluate('on the fake sandbox', { environment: host }, async () => {})
