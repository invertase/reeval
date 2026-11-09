import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  harnesses: fakeHarness(),
  sandbox: fakeSandbox(),
  cloud: true,
  profiles: { here: { cloud: false }, there: { defaults: { runs: 2 } } },
})
