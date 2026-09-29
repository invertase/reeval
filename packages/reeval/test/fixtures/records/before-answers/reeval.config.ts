import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

// A record corpus entry (before evals[].answers), recorded by reeval 0.2.0 at 879749e.
// Don't re-record it: test/corpus.test.ts reads it to prove this shape still loads.
export default defineConfig({
  harness: fakeHarness(),
  sandbox: fakeSandbox(),
  analysis: {
    model: fakeAnalysis({ output: () => ({ tldr: 'corpus', whatHappened: [], results: [], why: [], anomalies: [], actions: [], confidence: { overall: 'low', why: 'corpus' } }) }),
  },
})
