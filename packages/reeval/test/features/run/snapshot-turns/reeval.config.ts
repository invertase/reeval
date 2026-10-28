import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { snapshots } from './evals/env.ts'

export default defineConfig({
  harness: fakeHarness({ files: { 'app/built.js': 'export const built = true\n' } }),
  environment: snapshots,
})
