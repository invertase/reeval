import { defineConfig } from 'reeval'
import { cursor, fakeHarness } from 'reeval/harness'

export default defineConfig({
  harnesses: [cursor({ model: 'my-model' }), cursor({ model: 'gpt-5.6-luna-high' }), fakeHarness()],
  judge: { model: 'typesafe-ai/jev' },
})
