import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harnesses: [fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })],
  profiles: { vite: { limit: { traits: { stack: 'vite' } } } },
})
