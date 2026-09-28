import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

// Docker only: the fake sandbox can't enforce a policy, so reeval run would exit 2. REEVAL_EGRESS_TARGET
// is a listener on the host that features.test.ts starts, at a non-loopback address.
export default defineConfig({
  // As the agent: fetch the listener through the gateway.
  harness: fakeHarness({
    script: [[{ exec: `curl -sS -m 10 http://${process.env.REEVAL_EGRESS_TARGET}/` }]],
  }),
  sandbox:
    process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
})
