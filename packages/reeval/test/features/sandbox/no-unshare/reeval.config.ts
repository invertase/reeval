import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker and Podman only: the fake sandbox runs on the host, with the host's seccomp.
export default defineConfig({
  // As the agent: make a user and a network namespace of its own.
  harness: fakeHarness({
    script: [[{ exec: 'unshare --user --net true 2>&1; echo "exit=$?"' }]],
  }),
})
