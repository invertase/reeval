import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the image is the feature. The fake agent takes pi's layout and image, so
// REEVAL_BASE is pi's image and no key is needed.
export default defineConfig({
  harness: fakeHarness({ layout: 'pi' }),
})
