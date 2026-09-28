import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

// Docker only: the fake sandbox has no limits to set.
export default defineConfig({
  harness: fakeHarness(),
  sandbox:
    process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
      ? docker({ memory: '512m', cpus: 1, pids: 256 })
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
})
