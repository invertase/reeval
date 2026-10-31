import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the fake sandbox runs on the host as whoever runs reeval.
export default defineConfig({
  // As the agent: its uid and effective capabilities.
  harnesses: fakeHarness({
    script: [[{ exec: `echo "$(id -u) $(awk '/^CapEff/ {print $2}' /proc/self/status)"` }]],
  }),
})
