import { defineConfig } from 'reeval'
import { composer } from './evals/harnesses.ts'

export default defineConfig({
  include: ['evals/**/*.eval.ts'],
  harness: composer,
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  // agent: true writes a note on each eval and harness after its attempts, on the judge's model:
  // one more call per eval and harness, every run, so it's off here.
  timeout: '15m',
  // CI runs are PR runs unless a workflow says --profile nightly.
  defaultProfile: { ci: 'pr' },
  profiles: {
    // Cheap and fast: one run per cell, no variants (except where an eval pins compare).
    pr: {
      limit: { runs: 1, compare: false, harness: ['cursor:composer-2.5'] },
      budget: { attempts: 20 },
    },
    // The nightly real-agent smoke: the judge-free evals tagged smoke, once, on the cheap model.
    smoke: {
      limit: { runs: 1, compare: false, harness: ['cursor:composer-2.5'] },
      tags: ['smoke'],
      budget: { attempts: 5, duration: '15m' },
    },
    // The nightly compare-question check: evals/questions.eval.ts on Cursor and pi, 4 attempts,
    // its question answered by the judge's model (test/questions-real.test.ts).
    questions: { tags: ['questions'], budget: { attempts: 4 } },
    // Thorough: three runs per cell for evals that don't choose, recorded every time.
    nightly: {
      defaults: { runs: 3 },
      record: 'always',
      budget: { attempts: 80, duration: '2h' },
    },
  },
})
