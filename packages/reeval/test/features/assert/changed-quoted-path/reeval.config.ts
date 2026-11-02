import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// A non-ASCII path, which git C-quotes in a diff unless asked not to.
export default defineConfig({
  harnesses: fakeHarness({ script: [[{ write: { 'notes/café.txt': 'bonjour\n' } }]] }),
})
