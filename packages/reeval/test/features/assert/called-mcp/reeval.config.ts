import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  harness: fakeHarness({
    tools: [{ tool: 'mcp__stamp__house_stamp', input: {}, output: 'STAMP-7Q' }],
  }),
})
