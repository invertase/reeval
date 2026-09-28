import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

// The config adds a capability; the rooted profile runs every eval that doesn't pick its own
// sandbox as root.
export default defineConfig({
  harness: fakeHarness(),
  sandbox: docker({ capabilities: ['NET_RAW'] }),
  profiles: { rooted: { defaults: { sandbox: docker({ root: true }) } } },
})
