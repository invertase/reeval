import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  harnesses: fakeHarness({
    files: {
      'src/app.ts': 'export const app = () => "hello"\n',
      'src/util.ts': 'export const twice = (n: number) => n * 2\n',
      'src/app.test.ts': 'test("app", () => {})\n',
      'src/cache.tmp': 'ignored\n',
      'notes.md': 'what I did\n',
    },
  }),
  judge: { model: fakeJudge({ score: 1 }) },
})
