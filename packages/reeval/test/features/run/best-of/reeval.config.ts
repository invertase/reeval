import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { bestOf } from './evals/env.ts'

export default defineConfig({
  harnesses: fakeHarness({}),
  environments: bestOf,
})
