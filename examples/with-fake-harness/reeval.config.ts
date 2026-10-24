import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent with one list of steps per c.send(). `exec` runs a real command in the
  // sandbox, reported as a shell call; `write` edits files; `reply` is the turn's final message.
  harness: fakeHarness({
    script: [
      [
        { exec: 'ls src test' },
        {
          write: {
            'src/math.js': fakeAgent('src/math.js'),
            'test/math.test.js': fakeAgent('test/math.test.js'),
          },
        },
        { reply: 'I added multiply(a, b) to src/math.js and a test for it.' },
      ],
      [{ exec: 'node --test' }, { reply: 'All 2 tests pass.' }],
    ],
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
