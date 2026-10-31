import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { snapshots } from './evals/env.ts'

export default defineConfig({
  harnesses: fakeHarness({ files: { 'app/built.js': 'export const built = true\n' } }),
  environments: snapshots,
})
