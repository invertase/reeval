import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

// A record corpus entry (the corpus project's fake-harness runs with questions at the eval root: pairwise ones with across, and ones asked of each attempt, with choices and in words), recorded by reeval 0.13.0 at db7d81bf.
// Don't re-record it: test/corpus.test.ts reads it to prove this shape still loads.
export default defineConfig({
  harness: fakeHarness(),
  environment: defineEnvironment('fake', { sandbox: fakeSandbox() }),
  analysis: {
    model: fakeAnalysis({
      output: () => ({
        tldr: 'corpus',
        whatHappened: [],
        results: [],
        why: [],
        anomalies: [],
        actions: [],
        confidence: { overall: 'low', why: 'corpus' },
      }),
    }),
  },
})
