// The nightly real-agent checks (real.yml's `real agents (Cursor)` job): `--profile smoke` from
// scripts/real-smoke.sh, and `--profile questions` under reeval.analysis.config.ts from
// test/questions-real.test.ts.
import { defineConfig } from 'reeval'
import { composer } from './evals/harnesses.ts'

export default defineConfig({
  include: ['evals/**/*.eval.ts'],
  harness: composer,
  timeout: '15m',
  profiles: {
    // The judge-free evals tagged smoke, once, on the cheap model.
    smoke: {
      limit: { runs: 1, compare: false, harness: ['cursor:composer-2.5'] },
      tags: ['smoke'],
      budget: { attempts: 5, duration: '15m' },
    },
    // evals/questions.eval.ts on Cursor and pi, 4 attempts, its question answered by the
    // analysis model.
    questions: { tags: ['questions'], budget: { attempts: 4 } },
  },
})
