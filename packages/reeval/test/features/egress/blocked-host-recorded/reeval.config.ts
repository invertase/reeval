import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the fake sandbox can't enforce a policy, so reeval run would exit 2.
export default defineConfig({
  // As the agent: ask for a host the policy doesn't list, over plain HTTP, so the refusal's body
  // is the output. The name never resolves: the gateway refuses it before any lookup.
  harness: fakeHarness({ script: [[{ exec: 'curl -sS -m 10 http://blocked.invalid/' }]] }),
})
