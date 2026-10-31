import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Podman only: which network a rootless container is on is Podman's question.
export default defineConfig({
  harnesses: fakeHarness(),
})
