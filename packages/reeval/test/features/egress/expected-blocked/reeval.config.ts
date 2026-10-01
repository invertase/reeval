import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { calls } from './evals/env.ts'

// Docker only: the fake sandbox can't enforce a policy, so reeval run would exit 2. The fake agent
// with Antigravity's layout expects what real Antigravity does: its CLI's telemetry hosts.
export default defineConfig({
  harness: fakeHarness({ layout: 'antigravity', script: [[{ exec: calls }]] }),
})
