import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  harnesses: fakeHarness({
    files: {
      'README.md':
        '# wordcount\n\nInstall with `npm i -g .`, then run `wordcount notes.txt`.\n' +
        'Run `wordcount --help` for usage.\n',
    },
    text: 'I wrote README.md.',
  }),
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: 0.9 }) },
})
