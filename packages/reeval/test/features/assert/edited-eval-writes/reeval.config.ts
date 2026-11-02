import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// The eval rewrites notes.txt with c.exec before the turn; the agent only reads it.
export default defineConfig({
  harnesses: fakeHarness({ script: [[{ exec: 'cat notes.txt' }]] }),
})
