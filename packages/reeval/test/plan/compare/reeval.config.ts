import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harness: [fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })],
  profiles: {
    lean: { limit: { compare: { maxVariants: 1 } } },
    off: { limit: { compare: false } },
  },
})
