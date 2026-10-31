import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

/** The config default, which a compare.control replaces. */
export const node22 = defineEnvironment('node22', {
  sandbox: docker({ from: 'node:22-bookworm' }),
})

export default defineConfig({
  harnesses: fakeHarness(),
  sandbox: docker({ from: 'node:24-bookworm' }),
  environments: node22,
})
