import { defineConfig } from 'reeval'
import { direct } from 'reeval/gateway'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { fakeGateway } from 'reeval/testing'

export default defineConfig({
  harness: fakeHarness({ id: 'a' }),
  sandbox: fakeSandbox(),
  gateway: [fakeGateway({ serves: [] }), direct()],
  profiles: {
    faked: { gateway: [fakeGateway(), direct()] },
    pinned: { defaults: { harness: fakeHarness({ id: 'p', gateway: 'direct' }) } },
  },
})
