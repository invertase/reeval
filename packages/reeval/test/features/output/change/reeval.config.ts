import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  harness: fakeHarness({}),
  // One attempt a cell, where a compare would otherwise run 4 a side.
  runs: 1,
  sandbox: fakeSandbox(),
})
