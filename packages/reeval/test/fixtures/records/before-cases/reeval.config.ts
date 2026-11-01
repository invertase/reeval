import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

// A record corpus entry (an eval with cases as pooled family members, before evals[].cases: a passRate gate with a case of verdict family, gate all, where with families[].excluded, a paired lift below its minLift, one case and a survey), recorded by reeval 0.17.2.
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
