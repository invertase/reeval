import { defineConfig } from 'reeval'
import { direct } from 'reeval/gateway'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  harnesses: fakeHarness({ id: 'a' }),
  sandbox: fakeSandbox(),
  profiles: { listed: { gateway: [direct()] } },
})
