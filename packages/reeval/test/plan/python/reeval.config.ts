import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  include: ['evals/**/*.eval.py'],
  harnesses: fakeHarness({}),
  sandbox: fakeSandbox(),
})
