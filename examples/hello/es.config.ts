import { defineConfig } from 'evalsuite'
import { docker } from 'evalsuite/sandbox'
import { composer } from './evals/harnesses.ts'

export default defineConfig({
  include: ['evals/**/*.es.ts'],
  harness: composer,
  sandbox: docker(),
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
  // CI runs are PR runs unless a workflow says --profile nightly.
  defaultProfile: { ci: 'pr' },
  profiles: {
    // Cheap and fast: one run per cell, no variants (except where an eval pins compare).
    pr: {
      limit: { runs: 1, compare: false, harness: ['cursor:composer-2.5'] },
      budget: { attempts: 20 },
    },
    // Thorough: three runs per cell for evals that don't choose, recorded every time.
    nightly: {
      defaults: { runs: 3 },
      record: 'always',
      budget: { attempts: 80, duration: '2h' },
    },
  },
})
