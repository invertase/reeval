import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// Docker only: the fake sandbox can't enforce a policy, so es run would exit 2.
export default defineConfig({
  // As the agent: fetch the listener, which is the brokered secret's host.
  harness: fakeHarness({
    script: [[{ exec: `curl -sS -m 10 http://${process.env.ES_EGRESS_TARGET}/` }]],
  }),
  sandbox:
    process.env.ES_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
})
