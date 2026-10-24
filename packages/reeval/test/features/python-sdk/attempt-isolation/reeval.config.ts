import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

// REEVAL_FIXTURE_SANDBOX picks fake (F) or docker (D).
const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) })

export default defineConfig({
  include: ['evals/**/*.eval.py'],
  harness: fakeHarness({ script: [[{ reply: 'Nothing to do.' }]] }),
  sandbox,
})
