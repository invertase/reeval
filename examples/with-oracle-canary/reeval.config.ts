import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const read = (path: string) => readFileSync(new URL(`./${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // The oracle: a scripted agent that fixes the bug right, with ./oracle's files. It must pass.
  harness: fakeHarness({
    files: { 'src/math.js': read('oracle/src/math.js') },
    text: 'sum() started at index 1; it starts at 0 now.',
  }),
  // The sandbox real agents run in, so the checks pass or fail as they would for them.
  sandbox: docker(),
  profiles: {
    // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
    // profiles go beside them.
    ...profiles,
    // The canary: a scripted agent that guts the test instead, with ./canary's files. It must
    // fail. It sets only the harness, so it runs in the same sandbox.
    canary: {
      defaults: {
        harness: fakeHarness({
          files: { 'test/math.test.js': read('canary/test/math.test.js') },
          text: 'npm test passes now.',
        }),
      },
    },
  },
})
