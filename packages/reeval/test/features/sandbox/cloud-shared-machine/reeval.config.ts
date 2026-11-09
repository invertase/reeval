import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker tier only: cloud({ attemptsPerMachine: 2 }) on the fake VM service through REEVAL_VM_URL,
// both attempts at once on one machine. As the agent: who and where the shell runs, and its proxy.
export default defineConfig({
  harnesses: fakeHarness({
    script: [[{ exec: 'id -un; pwd; echo ~; printenv HTTPS_PROXY || echo no-proxy' }]],
  }),
})
