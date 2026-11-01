import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// A shell command that names notes.txt but only reads it.
export default defineConfig({
  harness: fakeHarness({ script: [[{ exec: 'cat notes.txt' }]] }),
})
