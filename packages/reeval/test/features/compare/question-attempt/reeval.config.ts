import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// The answer reports what the attempt's question was shown as its text, for the record check.
export default defineConfig({
  harnesses: fakeHarness({ files: { 'out.txt': 'hi\n' }, text: 'REPLY-MARK' }),
  analysis: {
    model: fakeAnalysis({
      answer: (q) => ({
        choice: 'yes',
        text: JSON.stringify({
          keys: Object.keys(q.attempt).sort(),
          choices: q.choices,
          task: q.prompt.includes('<task>'),
          reply: q.prompt.includes('REPLY-MARK'),
        }),
      }),
    }),
  },
})
