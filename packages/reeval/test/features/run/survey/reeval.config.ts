import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { survey } from './evals/env.ts'

export default defineConfig({
  harnesses: fakeHarness({}),
  environments: survey,
})
