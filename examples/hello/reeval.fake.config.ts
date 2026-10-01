// Runs the evals that need no credentials, Docker or network: a fake agent writes canned files
// into a temp dir, and the judge returns a canned verdict. The fake agent writes the house-style
// greeting only when it's given a skill, so skill.eval.ts shows the compare and its lift.
// analysis.agent writes a canned note on each eval and harness into .reeval/analysis/.
// (python.eval.ts needs the real agent and custom.eval.ts needs a Gemini key in the sandbox.)
import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

const packageJson = '{ "type": "module" }\n'

export default defineConfig({
  include: ['evals/hello.eval.ts', 'evals/preferences.eval.ts', 'evals/skill.eval.ts'],
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
  environment: defineEnvironment('fake', { sandbox: fakeSandbox() }),
  judge: { model: fakeJudge({ score: 0.95 }) },
  analysis: {
    agent: true,
    model: fakeAnalysis({
      note: ({ harness, attempts }) =>
        `${attempts.filter((a) => a.outcome === 'pass').length} of ${attempts.length} attempts passed on ${harness}.`,
      // skill.eval.ts's compare question: the attempt whose greet.js says Ahoy wins.
      vote: (p) =>
        p.a.includes('Ahoy') === p.b.includes('Ahoy') ? 'tie' : p.a.includes('Ahoy') ? 'A' : 'B',
      // The run's summary, cached once the run is written; reeval analyze shows it.
      output: {
        tldr: 'The house-style skill changes the greeting: its variant passes where the control misses.',
        whatHappened: [],
        results: [],
        why: [],
        anomalies: [],
        actions: [],
        confidence: { overall: 'low', why: 'A fake analysis model wrote this.' },
      },
    }),
  },
  timeout: '2m',
  profiles: {
    smoke: { limit: { runs: 1, compare: false }, budget: { attempts: 12 } },
    nightly: { defaults: { runs: 3 }, budget: { attempts: 40, duration: '10m' } },
  },
})
