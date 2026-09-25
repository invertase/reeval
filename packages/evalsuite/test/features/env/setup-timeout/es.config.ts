import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// ES_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  harness: fakeHarness({}),
  sandbox:
    process.env.ES_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
})
