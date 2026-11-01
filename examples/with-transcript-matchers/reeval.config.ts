import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that writes ./fake-agent's files, then runs the tests as a shell tool call,
  // so the transcript has an edit and a command to check without keys or Docker.
  harnesses: fakeHarness({
    script: [
      [
        {
          write: {
            'src/math.js': fakeAgent('src/math.js'),
            'test/math.test.js': fakeAgent('test/math.test.js'),
          },
        },
        { exec: 'node --test' },
        { reply: 'I added multiply(a, b) to src/math.js with a test, and the tests pass.' },
      ],
    ],
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
