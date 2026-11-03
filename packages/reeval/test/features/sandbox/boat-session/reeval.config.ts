import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker tier only: boat() on the fake Boat API, whose sandboxes are sshd containers laid out like a
// Boat VM. As the agent: who and where the shell runs, which node it finds, and its proxy.
export default defineConfig({
  harnesses: fakeHarness({
    script: [[{ exec: 'id -un; pwd; command -v node; printenv HTTPS_PROXY || echo no-proxy' }]],
  }),
})
