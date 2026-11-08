import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker tier only: daytona() on the fake Daytona API, whose sandboxes are sshd containers that a
// token logs in to with no key, as Daytona's SSH gateway takes one. As the agent: who and where the
// shell runs, which node it finds, and its proxy.
export default defineConfig({
  harnesses: fakeHarness({
    script: [[{ exec: 'id -un; pwd; command -v node; printenv HTTPS_PROXY || echo no-proxy' }]],
  }),
})
