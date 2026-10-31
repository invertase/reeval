import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { eachCase } from './evals/env.ts'

export default defineConfig({
  harnesses: fakeHarness({}),
  environments: eachCase,
})
