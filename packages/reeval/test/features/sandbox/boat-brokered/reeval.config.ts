import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker tier only: boat() on the fake Boat API. As the agent: print the brokered secret.
export default defineConfig({
  harnesses: fakeHarness({ script: [[{ exec: 'printenv API_KEY' }]] }),
})
