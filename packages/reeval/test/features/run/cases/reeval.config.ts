import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { cases } from './evals/env.ts'

export default defineConfig({
  harnesses: fakeHarness({}),
  environments: cases,
})
