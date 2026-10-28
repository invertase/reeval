import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { keptWorkspace } from './evals/env.ts'

export default defineConfig({
  harness: fakeHarness({ files: { 'app/built.js': 'export const built = true\n' } }),
  environment: keptWorkspace,
})
