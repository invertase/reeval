import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

// Docker only: the image is the feature. The fake agent takes Claude Code's layout and image,
// so ES_BASE is Claude Code's image and no key is needed.
export default defineConfig({
  harness: fakeHarness({ layout: 'claude-code' }),
  sandbox: docker({ dockerfile: './docker/Dockerfile', id: 'docker' }),
})
