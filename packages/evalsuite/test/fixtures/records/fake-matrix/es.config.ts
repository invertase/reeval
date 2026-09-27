import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { fakeAnalysis } from 'evalsuite/judge'
import { fakeSandbox } from 'evalsuite/sandbox'

// A record corpus entry (the fake harness: compare, judges, failures, infra errors, todo, skip, budget stop, saved analysis), recorded by ES 0.0.1 at 0648f37 (#106).
// Don't re-record it: test/corpus.test.ts reads it to prove this shape still loads.
export default defineConfig({
  harness: fakeHarness(),
  sandbox: fakeSandbox(),
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
