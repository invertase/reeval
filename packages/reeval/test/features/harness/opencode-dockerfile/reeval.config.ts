import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

// Docker only: the image is the feature. The fake agent takes OpenCode's layout and image, so
// ES_BASE is OpenCode's image and no key is needed.
export default defineConfig({
  harness: fakeHarness({ layout: 'opencode' }),
  sandbox: docker({ dockerfile: './docker/Dockerfile', id: 'docker' }),
})
