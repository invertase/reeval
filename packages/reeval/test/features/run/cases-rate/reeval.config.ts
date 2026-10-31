import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { rate } from './evals/env.ts'

export default defineConfig({
  harnesses: fakeHarness({}),
  environments: rate,
})
