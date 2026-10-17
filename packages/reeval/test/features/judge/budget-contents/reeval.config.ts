import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  harness: fakeHarness({
    files: {
      'a.txt': 'small a\n',
      'big.txt': `${'word '.repeat(1000)}\n`,
      'b.txt': 'small b\n',
    },
  }),
  judge: { model: fakeJudge({ score: 1 }) },
})
