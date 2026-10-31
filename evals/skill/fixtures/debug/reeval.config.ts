import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  harnesses: fakeHarness({
    files: {
      'src/slug.js':
        'export function slugify(text) {\n' +
        "  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')\n" +
        '}\n',
      'package.json': '{ "type": "module" }\n',
    },
    text: 'I wrote src/slug.js.',
  }),
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: 0.9 }) },
})
