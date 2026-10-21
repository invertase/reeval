import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// As the agent: start the environment's stdio server and call its tool.
export default defineConfig({
  harness: fakeHarness({ script: [[{ mcp: 'stamp/house_stamp' }, { reply: 'stamped' }]] }),
})
