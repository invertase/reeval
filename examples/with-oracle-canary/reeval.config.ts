import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const read = (path: string) => readFileSync(new URL(`./${path}`, import.meta.url), 'utf8')
const writes = (dir: string) => ({
  'src/math.js': read(`${dir}/src/math.js`),
  'test/math.test.js': read(`${dir}/test/math.test.js`),
})

export default defineConfig({
  include: ['*.eval.ts'],
  // The oracle: a scripted agent that does the task right, with ./oracle's files. It must pass.
  harnesses: fakeHarness({
    files: writes('oracle'),
    text: 'I added clamp(n, min, max) and a test.',
  }),
  // The sandbox real agents run in, so the checks pass or fail as they would for them.
  sandbox: docker(),
  profiles: {
    // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
    // profiles go beside them.
    ...profiles,
    // The canary: a scripted agent whose clamp ignores min and max, with a test too weak to
    // notice, from ./canary. It must fail. It sets only the harness, so it runs in the same
    // sandbox.
    canary: {
      defaults: {
        harnesses: fakeHarness({ files: writes('canary'), text: 'I added clamp and a test.' }),
      },
    },
  },
})
