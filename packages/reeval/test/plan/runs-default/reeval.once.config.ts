import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// A config-level runs is explicit, so a compare under it runs once too.
export default defineConfig({ harnesses: fakeHarness({ id: 'a' }), runs: 1 })
