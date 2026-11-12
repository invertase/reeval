import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker tier only: boat() on the fake Boat API, with the run's event stream's heartbeats.
export default defineConfig({ harnesses: fakeHarness() })
