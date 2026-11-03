import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

// A record corpus entry (evals[].family from reeval 0.18.0 evaluate.each, before cases, plural option keys and compare.control: a pooled family whose case holds a slash, and the renamed options on a group and an eval), recorded by reeval 0.18.0.
// Don't re-record it: test/corpus.test.ts reads it to prove this shape still loads.
export default defineConfig({
  harnesses: fakeHarness(),
  environments: defineEnvironment('fake', { sandbox: fakeSandbox() }),
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
