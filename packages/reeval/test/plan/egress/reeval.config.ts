import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

// REEVAL_EGRESS_FAKE=1 swaps in the fake sandbox, which can't enforce a policy: the plan exits 2.
export default defineConfig({
  harness: fakeHarness(),
  sandbox: process.env.REEVAL_EGRESS_FAKE === '1' ? fakeSandbox() : docker(),
  egress: { allow: ['config.example.com'] },
  profiles: { locked: { defaults: { egress: 'deny-all' } } },
})
