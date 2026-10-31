import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

/** No default environments: an omitted baseline is the empty control. */
export default defineConfig({
  harnesses: fakeHarness(),
})
