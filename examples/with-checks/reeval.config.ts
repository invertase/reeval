import { defineConfig } from 'reeval'
import { cursor, fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that writes the files the task asks for, so the checks run without keys or
  // Docker. It always does the task right: swap in a real agent to see the checks catch one.
  harness: fakeHarness({
    files: {
      'greet.js': "export function greet(name) {\n  return 'Hello, ' + name + '!'\n}\n",
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
    text: 'I created greet.js and greet.test.js.',
  }),
  sandbox: fakeSandbox(),
  profiles: {
    // The same eval on a real agent in Docker: needs CURSOR_API_KEY and
    // `reeval image build --profile cursor` once.
    cursor: { defaults: { harness: cursor({ model: 'composer-2.5' }), sandbox: docker() } },
  },
})
