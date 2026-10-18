import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the image is the feature. The fake agent takes Grok Build's layout and image, so
// REEVAL_BASE is Grok Build's image and no key is needed.
export default defineConfig({
  harness: fakeHarness({ layout: 'grok-build' }),
})
