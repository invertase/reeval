import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  harnesses: fakeHarness({
    usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: null },
    tools: [
      { tool: 'bash', input: { command: 'ls' }, output: '' },
      { tool: 'bash', input: { command: 'pwd' }, output: '/' },
    ],
  }),
})
