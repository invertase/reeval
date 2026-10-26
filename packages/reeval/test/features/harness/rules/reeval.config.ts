import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { layout } from './layout.ts'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes REEVAL_FIXTURE_LAYOUT's layout (and image), so no key is needed.
export default defineConfig({
  harness: fakeHarness({ layout }),
})
