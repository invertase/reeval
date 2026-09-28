import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

// Docker only: the image is the feature. The fake agent takes pi's layout and image, so
// REEVAL_BASE is pi's image and no key is needed.
export default defineConfig({
  harness: fakeHarness({ layout: 'pi' }),
  sandbox: docker({ dockerfile: './docker/Dockerfile', id: 'docker' }),
})
