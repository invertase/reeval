import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harness: [fakeHarness({ id: 'left' }), fakeHarness({ id: 'right' })],
})
