import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

/** No default environment: an omitted baseline is the empty control. */
export default defineConfig({
  harness: fakeHarness(),
})
