import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  harnesses: fakeHarness(),
  sandbox: fakeSandbox(),
  hosted: true,
  profiles: { here: { hosted: false }, there: { defaults: { runs: 2 } } },
})
