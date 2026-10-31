import { defineConfig } from 'reeval'
import { direct } from 'reeval/gateway'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  harnesses: fakeHarness({ id: 'a' }),
  sandbox: fakeSandbox(),
  gateway: [direct()],
  profiles: {
    pinned: { defaults: { harnesses: fakeHarness({ id: 'p', gateway: 'direct' }) } },
  },
})
