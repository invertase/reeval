import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_EGRESS_FAKE=1 swaps in the fake sandbox, which can't enforce a policy: the plan exits 2.
export default defineConfig({
  harness: fakeHarness(),
  egress: { allow: ['config.example.com'] },
  profiles: { locked: { defaults: { egress: 'deny-all' } } },
})
