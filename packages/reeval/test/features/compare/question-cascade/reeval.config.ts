import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// The question's vote reports what it was shown as its reason, for the record check.
export default defineConfig({
  harness: fakeHarness({ files: { 'out.txt': 'hi\n' }, text: 'REPLY-MARK' }),
  question: { state: { output: true } },
  analysis: {
    model: fakeAnalysis({
      vote: (p) => ({
        winner: 'tie',
        reason: JSON.stringify({ keys: Object.keys(p.a).sort(), files: p.a.files }),
      }),
    }),
  },
})
