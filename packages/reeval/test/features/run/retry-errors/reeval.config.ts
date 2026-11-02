import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { retry } from './evals/env.ts'

// REEVAL_FIXTURE_OUTAGE stands in for an outage before the first turn: the first run's attempts
// end in an infra error, and `--retry-errors` runs them again without it.
export default defineConfig({
  harnesses: fakeHarness(
    process.env.REEVAL_FIXTURE_OUTAGE ? { failWith: 'fixture outage before the first turn' } : {},
  ),
  environments: retry,
})
