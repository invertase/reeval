import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
const root =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker({ id: 'from-root' })
    : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url), id: 'from-root' })

const unused =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker({ id: 'from-config-env' })
    : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url), id: 'from-config-env' })

export default defineConfig({
  harness: fakeHarness({}),
  // One attempt a cell, where a compare would otherwise run 4 a side.
  runs: 1,
  sandbox: root,
  // Present so the fixture can prove a named env does not inherit this sandbox.
  environment: defineEnvironment('config', { sandbox: unused }),
})
