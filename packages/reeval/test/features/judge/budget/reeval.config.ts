import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  harness: fakeHarness({
    tools: Array.from({ length: 40 }, (_, i) => ({
      tool: 'shell',
      input: { command: `step ${i + 1}` },
      output: 'x'.repeat(200),
    })),
  }),
  judge: { model: fakeJudge({ score: 1 }) },
})
