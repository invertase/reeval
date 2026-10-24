import { defineConfig } from 'reeval'
import { cursor, fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

const packageJson = '{ "type": "module" }\n'

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that greets in the house style only when the environment gives it a skill,
  // so the compare shows a lift without keys or Docker.
  harness: fakeHarness({
    files: {
      'greet.js': "export function greet(name) {\n  return 'Hello, ' + name + '!'\n}\n",
      'package.json': packageJson,
    },
    text: 'I created greet.js.',
    withSkill: {
      files: {
        'greet.js': "export function greet(name) {\n  return 'Ahoy, ' + name + '!'\n}\n",
        'package.json': packageJson,
      },
      text: 'I created greet.js in the house style.',
    },
  }),
  sandbox: fakeSandbox(),
  profiles: {
    // The same compare on a real agent in Docker: needs CURSOR_API_KEY and
    // `reeval image build --profile cursor` once.
    cursor: { defaults: { harness: cursor({ model: 'composer-2.5' }), sandbox: docker() } },
  },
})
