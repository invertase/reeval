import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  harness: fakeHarness({
    script: [
      [{ write: { 'greet.js': "export const greet = (n) => 'Hello, ' + n\n" } }],
      [{ write: { 'notes.md': 'done\n' } }],
    ],
  }),
})
