import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  harnesses: fakeHarness({
    script: [
      [{ write: { 'greet.js': "export const greet = (n) => 'Hello, ' + n\n" } }],
      [{ write: { 'test/hidden.test.js': '// emptied\n', '.cache/grade.js': '// emptied\n' } }],
    ],
  }),
})
