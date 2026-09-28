import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

// Docker only: the image is the feature. The fake agent takes pi's layout and image, so
// ES_BASE is pi's image and no key is needed.
export default defineConfig({
  harness: fakeHarness({ layout: 'pi' }),
  sandbox: docker({ dockerfile: './docker/Dockerfile', id: 'docker' }),
})
