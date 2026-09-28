import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker, fakeSandbox } from 'evalsuite/sandbox'

// Docker only: the fake sandbox runs on the host as whoever runs ES.
export default defineConfig({
  // As the agent: its uid and effective capabilities.
  harness: fakeHarness({
    script: [[{ exec: `echo "$(id -u) $(awk '/^CapEff/ {print $2}' /proc/self/status)"` }]],
  }),
  sandbox:
    process.env.ES_FIXTURE_SANDBOX === 'docker'
      ? docker()
      : fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
})
