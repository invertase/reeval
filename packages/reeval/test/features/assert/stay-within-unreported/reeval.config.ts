import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// The fake agent reports no usage, so a tokens limit can't be checked either way.
export default defineConfig({
  harnesses: fakeHarness({ tools: [{ tool: 'bash', input: { command: 'ls' }, output: '' }] }),
})
