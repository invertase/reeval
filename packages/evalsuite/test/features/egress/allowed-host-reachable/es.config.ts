import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// Docker only: the fake sandbox can't enforce a policy, so es run would exit 2. ES_EGRESS_TARGET
// is a listener on the host that features.test.ts starts, at a non-loopback address.
export default defineConfig({
  // As the agent: fetch the listener through the gateway.
  harness: fakeHarness({
    script: [[{ exec: `curl -sS -m 10 http://${process.env.ES_EGRESS_TARGET}/` }]],
  }),
  sandbox:
    process.env.ES_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
})
