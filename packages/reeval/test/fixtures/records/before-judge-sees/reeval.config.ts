import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

// A record corpus entry (before stack.judge.sees and judge-input.json's sees (what each judge call chose to see)), recorded by reeval 0.9.0 at 0999c19.
// Don't re-record it: test/corpus.test.ts reads it to prove this shape still loads.
export default defineConfig({
  harness: fakeHarness(),
  environment: defineEnvironment('fake', { sandbox: fakeSandbox() }),
  analysis: {
    model: fakeAnalysis({ output: () => ({ tldr: 'corpus', whatHappened: [], results: [], why: [], anomalies: [], actions: [], confidence: { overall: 'low', why: 'corpus' } }) }),
  },
})
