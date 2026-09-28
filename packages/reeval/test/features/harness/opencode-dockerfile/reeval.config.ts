import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

// Docker only: the image is the feature. The fake agent takes OpenCode's layout and image, so
// REEVAL_BASE is OpenCode's image and no key is needed.
export default defineConfig({
  harness: fakeHarness({ layout: 'opencode' }),
  sandbox: docker({ dockerfile: './docker/Dockerfile', id: 'docker' }),
})
