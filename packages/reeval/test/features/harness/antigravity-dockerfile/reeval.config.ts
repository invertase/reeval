import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

// Docker only: the image is the feature. The fake agent takes Antigravity's layout and image,
// so REEVAL_BASE is Antigravity's image and no key is needed.
export default defineConfig({
  harness: fakeHarness({ layout: 'antigravity' }),
  sandbox: docker({ dockerfile: './docker/Dockerfile', id: 'docker' }),
})
