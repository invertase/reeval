import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker tier only: boat() on the fake Boat API, whose /proc c.serve and the kill tree read.
export default defineConfig({ harnesses: fakeHarness() })
