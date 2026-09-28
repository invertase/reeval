import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

// The config adds a capability; the rooted profile runs every eval that doesn't pick its own
// sandbox as root.
export default defineConfig({
  harness: fakeHarness(),
  sandbox: docker({ capabilities: ['NET_RAW'] }),
  profiles: { rooted: { defaults: { sandbox: docker({ root: true }) } } },
})
