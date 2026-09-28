import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { fakeSandbox } from 'evalsuite/sandbox'

export default defineConfig({
  harness: [fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })],
  sandbox: fakeSandbox(),
  profiles: { lean: { limit: { compare: { maxVariants: 1 } } } },
})
