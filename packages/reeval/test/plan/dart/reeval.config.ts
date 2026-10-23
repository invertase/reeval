import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  include: ['evals/**/*.eval.dart'],
  harness: fakeHarness({}),
  sandbox: fakeSandbox(),
})
