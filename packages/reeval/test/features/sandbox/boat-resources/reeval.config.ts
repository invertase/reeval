import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker tier only: boat() on the fake Boat API, whose sshd containers have a VM's /proc and /sys.
export default defineConfig({ harnesses: fakeHarness() })
