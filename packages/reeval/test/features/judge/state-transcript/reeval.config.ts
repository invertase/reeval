import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  harness: fakeHarness({
    reasoning: 'thinking it over',
    tools: [{ tool: 'shell', input: { command: 'npm test' }, output: '14 passing' }],
    files: { 'src/app.ts': 'export const app = () => "hello"\n' },
  }),
  judge: { model: fakeJudge({ score: 1 }) },
})
