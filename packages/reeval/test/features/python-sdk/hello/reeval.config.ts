import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  include: ['evals/**/*.eval.py'],
  harness: fakeHarness({
    script: [[{ write: { 'marker.txt': 'python-ok\n' } }]],
  }),
  sandbox: fakeSandbox(),
})
