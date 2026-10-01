import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

export const net = defineEnvironment('net', {
  sandbox: docker({ capabilities: ['NET_RAW'] }),
})

export const rooted = defineEnvironment('rooted', {
  sandbox: docker({ root: true }),
})

// The config environment adds a capability; the rooted profile replaces it entirely.
export default defineConfig({
  harness: fakeHarness(),
  environment: net,
  profiles: { rooted: { defaults: { environment: rooted } } },
})
