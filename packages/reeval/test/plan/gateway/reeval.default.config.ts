import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  harness: fakeHarness({ id: 'a' }),
  sandbox: fakeSandbox(),
})
