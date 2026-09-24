// Runs the evals that need no credentials, Docker or network: a fake agent writes canned files
// into a temp dir, and the judge returns a canned verdict. (skill.es.ts and python.es.ts need the
// real agent, and custom.es.ts needs a Gemini key in the sandbox.)
import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { fakeJudge } from 'evalsuite/judge'
import { fakeSandbox } from 'evalsuite/sandbox'

export default defineConfig({
  include: ['evals/hello.es.ts', 'evals/preferences.es.ts'],
  harness: [
    fakeHarness({
      files: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the fake agent's file content
        'greet.js': "export function greet(name = 'world') {\n  return `Hello, ${name}!`\n}\n",
        'greet.test.js': [
          "import { test } from 'node:test'",
          "import assert from 'node:assert/strict'",
          "import { greet } from './greet.js'",
          '',
          "test('greets by name', () => assert.equal(greet('Ada'), 'Hello, Ada!'))",
          '',
        ].join('\n'),
        'package.json': '{ "type": "module" }\n',
      },
      text: 'I created greet.js exporting greet(name), and greet.test.js which tests it with node:test.',
    }),
  ],
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: 0.95 }) },
  timeout: '2m',
})
