import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harnesses: fakeHarness({ id: 'a' }),
  sandbox: { kind: 'fake' },
})
