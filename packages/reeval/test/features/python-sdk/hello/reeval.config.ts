import { defineConfig } from 'reeval'
import { cursor, fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { docker, fakeSandbox } from 'reeval/sandbox'

// REEVAL_FIXTURE_SANDBOX picks fake (F) or docker (D). REEVAL_FIXTURE_HARNESS=cursor is real Cursor (C).
const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) })

export default defineConfig({
  include: ['evals/**/*.eval.py'],
  harness:
    process.env.REEVAL_FIXTURE_HARNESS === 'cursor'
      ? cursor({
          model: process.env.REEVAL_REAL_MODEL ?? 'composer-2.5',
          params: { fast: 'false' },
        })
      : fakeHarness({
          script: [[{ write: { 'greet.py': 'print("hi")\n' } }, { reply: 'Created greet.py.' }]],
        }),
  sandbox,
  judge: { model: fakeJudge({ score: 1 }) },
})
