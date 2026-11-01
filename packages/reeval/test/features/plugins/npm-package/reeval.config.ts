import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  // As the agent: start the plugin's stdio server and call its tool.
  harnesses: fakeHarness({ script: [[{ mcp: 'review:docs/house_stamp' }, { reply: 'stamped' }]] }),
})
