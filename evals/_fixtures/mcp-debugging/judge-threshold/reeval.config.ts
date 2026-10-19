import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  harness: fakeHarness({
    files: {
      'README.md': '# notes\n\nA small notes CLI. Run `node notes.js add <text>`.\n',
    },
    text: 'Wrote README.md.',
  }),
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: 0.85 }) },
})
