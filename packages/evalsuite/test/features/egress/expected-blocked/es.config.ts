import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'
import { calls } from './evals/env.ts'

// Docker only: the fake sandbox can't enforce a policy, so es run would exit 2. The fake agent
// with Antigravity's layout expects what real Antigravity does: its CLI's telemetry hosts.
export default defineConfig({
  harness: fakeHarness({ layout: 'antigravity', script: [[{ exec: calls }]] }),
  sandbox:
    process.env.ES_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
})
