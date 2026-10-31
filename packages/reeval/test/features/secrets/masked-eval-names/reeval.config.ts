import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Fake tier only: the eval's name is masked on the host, whatever the sandbox.
export default defineConfig({ harnesses: fakeHarness() })
