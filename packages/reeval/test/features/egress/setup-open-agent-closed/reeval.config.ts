import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { direct, target } from './evals/env.ts'

// Docker only: the fake sandbox can't enforce a policy, so reeval run would exit 2.
export default defineConfig({
  // As the agent: reach the host's listener directly, around the proxy, then through the proxy.
  harnesses: fakeHarness({ script: [[{ exec: direct }, { exec: `curl -sS -m 10 ${target}` }]] }),
})
