import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

// REEVAL_EGRESS_FAKE=1 swaps in the fake sandbox, which can't enforce a policy: the plan exits 2.
const fake = defineEnvironment('fake', { sandbox: fakeSandbox() })

export default defineConfig({
  harness: fakeHarness(),
  ...(process.env.REEVAL_EGRESS_FAKE === '1' ? { environment: fake } : {}),
  egress: { allow: ['config.example.com'] },
  profiles: { locked: { defaults: { egress: 'deny-all' } } },
})
