// The weekly real-agent checks: `--profile smoke` from real.yml's `real agents (Cursor)` job and
// scripts/real-smoke.sh, and `--profile questions` under reeval.analysis.config.ts from
// test/questions-real.test.ts. `--profile ci` is where scripts/record-real-runs.sh records the
// real-agent runs, every contract leg's included.
import { defineConfig } from 'reeval'
import { s3 } from 'reeval/store/s3'
import { composer } from './evals/harnesses.ts'

export default defineConfig({
  include: ['evals/**/*.eval.ts'],
  harnesses: composer,
  timeout: '15m',
  profiles: {
    // The judge-free evals tagged smoke, once, on the cheap model.
    smoke: {
      limit: { runs: 1, compare: false, harnesses: ['cursor:composer-2.5'] },
      tags: ['smoke'],
      budget: { attempts: 5, duration: '15m' },
    },
    // evals/questions.eval.ts on Cursor and pi, 4 attempts, its question answered by the
    // analysis model.
    questions: { tags: ['questions'], budget: { attempts: 4 } },
    // The CI history on R2, kept indefinitely with every attempt's debug data. The keys are
    // GitHub Actions secrets and the endpoint and bucket repository variables, set on the
    // recording step only.
    ci: {
      history: {
        store: s3({
          env: {
            accessKeyId: 'R2_ACCESS_KEY_ID',
            secretAccessKey: 'R2_SECRET_ACCESS_KEY',
            endpoint: 'R2_ENDPOINT',
            bucket: 'R2_BUCKET',
          },
        }),
        artifacts: 'all',
        debug: 'all',
      },
    },
  },
})
