import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// Docker only: the fake sandbox has no limits to set.
export default defineConfig({
  harness: fakeHarness(),
  sandbox:
    process.env.ES_FIXTURE_SANDBOX === 'docker'
      ? docker({ memory: '512m', cpus: 1, pids: 256 })
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
})
