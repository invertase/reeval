import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// tart({ hosts }) on fake Macs a fake ssh reaches. As the agent, through the VM's harness session:
// where it runs, and long enough that the other attempt would find the host full.
export default defineConfig({
  harnesses: fakeHarness({ layout: 'cursor', script: [[{ exec: 'pwd; sleep 3' }]] }),
})
