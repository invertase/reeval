import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// `reeval run` starts in deep/nested/, which has its own marker.txt: reeval must find this config two
// directories up and resolve file() from here.
const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) })

export default defineConfig(({ file }) => ({
  harness: fakeHarness({}),
  environment: defineEnvironment('found', {
    sandbox,
    files: { 'marker.txt': file('marker.txt') },
  }),
}))
