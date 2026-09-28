import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

// Docker only: the fake sandbox runs on the host as whoever runs reeval.
export default defineConfig({
  // As the agent: its uid and effective capabilities.
  harness: fakeHarness({
    script: [[{ exec: `echo "$(id -u) $(awk '/^CapEff/ {print $2}' /proc/self/status)"` }]],
  }),
  sandbox:
    process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
})
