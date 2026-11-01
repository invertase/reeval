import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harnesses: [fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })],
  profiles: {
    lean: { limit: { compare: { maxVariants: 1 } } },
    off: { limit: { compare: false } },
    none: { limit: { compare: { maxVariants: 0 } } },
    // A language-model judge answers the questions that name no model of their own.
    judged: { judge: { model: 'google/gemini-3.8-flash' } },
    one: { limit: { harnesses: ['a'] } },
    'one-lean': { limit: { harnesses: ['a'], compare: { maxVariants: 1 } } },
  },
})
