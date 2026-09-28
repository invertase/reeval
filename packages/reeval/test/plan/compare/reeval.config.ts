import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  harness: [fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })],
  sandbox: fakeSandbox(),
  profiles: { lean: { limit: { compare: { maxVariants: 1 } } } },
})
