import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// No egress: every attempt runs under the default, 'proxy', unless it sets its own.
export default defineConfig({ harness: fakeHarness() })
