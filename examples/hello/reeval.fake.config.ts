// Runs the evals that need no credentials, Docker or network: a fake agent writes canned files
// into a temp dir, and the judge returns a canned verdict. The fake agent writes the house-style
// greeting only when it's given a skill, so skill.es.ts shows the compare and its lift.
// (python.es.ts needs the real agent and custom.es.ts needs a Gemini key in the sandbox.)
import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { fakeJudge } from 'evalsuite/judge'
import { fakeSandbox } from 'evalsuite/sandbox'

const packageJson = '{ "type": "module" }\n'

export default defineConfig({
  include: ['evals/hello.es.ts', 'evals/preferences.es.ts', 'evals/skill.es.ts'],
  harness: fakeHarness({
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
      'package.json': packageJson,
    },
    text: 'I created greet.js exporting greet(name), and greet.test.js which tests it with node:test.',
    withSkill: {
      files: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the fake agent's file content
        'greet.js': 'export function greet(name) {\n  return `Ahoy, ${name}!`\n}\n',
        'package.json': packageJson,
      },
      text: 'I created greet.js in the house style.',
    },
  }),
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: 0.95 }) },
  timeout: '2m',
  profiles: {
    smoke: { limit: { runs: 1, compare: false }, budget: { attempts: 12 } },
    nightly: { defaults: { runs: 3 }, budget: { attempts: 40, duration: '10m' } },
  },
})
