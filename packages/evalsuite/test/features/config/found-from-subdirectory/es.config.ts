import { defineConfig, defineEnvironment } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// ES_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// `es run` starts in deep/nested/, which has its own marker.txt: ES must find this config two
// directories up and resolve file() from here.
export default defineConfig(({ file }) => ({
  harness: fakeHarness({}),
  sandbox:
    process.env.ES_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
  environment: defineEnvironment('found', { files: { 'marker.txt': file('marker.txt') } }),
}))
