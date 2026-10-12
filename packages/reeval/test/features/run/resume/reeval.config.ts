import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { resume } from './evals/env.ts'

export default defineConfig({
  harness: fakeHarness({}),
  environment: resume,
})
