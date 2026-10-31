import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

// A record corpus entry (the fake harnesses: compare, judges, failures, infra errors, todo, skip, budget stop, saved analysis), recorded by reeval 0.0.1 at 0648f37 (#106).
// Don't re-record it: test/corpus.test.ts reads it to prove this shape still loads.
export default defineConfig({
  harnesses: fakeHarness(),
  environments: defineEnvironment('fake', { sandbox: fakeSandbox() }),
  // Its evals keep the names their records were made under.
  include: ['evals/**/*.es.ts'],
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
