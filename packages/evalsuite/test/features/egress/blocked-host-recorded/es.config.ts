import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// Docker only: the fake sandbox can't enforce a policy, so es run would exit 2.
export default defineConfig({
  // As the agent: ask for a host the policy doesn't list, over plain HTTP, so the refusal's body
  // is the output. The name never resolves: the gateway refuses it before any lookup.
  harness: fakeHarness({ script: [[{ exec: 'curl -sS -m 10 http://blocked.invalid/' }]] }),
  sandbox:
    process.env.ES_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
})
