import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker tier only: daytona() on the fake Daytona API, whose sshd containers have a VM's /proc and
// /sys.
export default defineConfig({ harnesses: fakeHarness() })
