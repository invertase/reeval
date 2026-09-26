import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// ES_EGRESS_FAKE=1 swaps in the fake sandbox, which can't enforce a policy: the plan exits 2.
export default defineConfig({
  harness: fakeHarness(),
  sandbox: process.env.ES_EGRESS_FAKE === '1' ? fakeSandbox() : docker(),
  egress: { allow: ['config.example.com'] },
  profiles: { locked: { defaults: { egress: 'deny-all' } } },
})
