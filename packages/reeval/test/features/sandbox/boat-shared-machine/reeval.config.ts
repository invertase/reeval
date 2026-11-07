import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker tier only: boat({ attemptsPerMachine: 2 }) on the fake Boat API, both attempts at once on
// one machine. As the agent: who and where the shell runs, and its proxy.
export default defineConfig({
  harnesses: fakeHarness({
    script: [[{ exec: 'id -un; pwd; echo ~; printenv HTTPS_PROXY || echo no-proxy' }]],
  }),
})
