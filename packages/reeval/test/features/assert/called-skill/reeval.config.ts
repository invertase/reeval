import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  harness: fakeHarness({
    tools: [{ tool: 'skill', input: { id: 'foo' }, output: 'loaded' }],
  }),
})
