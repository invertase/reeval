import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, docker (D) or podman.
export default defineConfig({
  // As the agent: print the brokered secret, then the proxy the gateway sets (or "no-proxy").
  harnesses: fakeHarness({
    script: [[{ exec: 'printenv API_KEY; printenv HTTPS_PROXY || echo no-proxy' }]],
  }),
})
