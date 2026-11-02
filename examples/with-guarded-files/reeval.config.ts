import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')
const canary = (path: string) => readFileSync(new URL(`./canary/${path}`, import.meta.url), 'utf8')
const files = {
  'src/math.js': fakeAgent('src/math.js'),
  'test/math.test.js': fakeAgent('test/math.test.js'),
}

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace, so the checks run
  // without keys or Docker.
  harnesses: fakeHarness({
    files,
    text: 'I added clamp(n, min, max) to src/math.js, with a test.',
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: {
    ...profiles,
    // An agent that does the task right but also adds a dependency, which the guard must catch.
    canary: {
      defaults: {
        harnesses: fakeHarness({
          files: { ...files, 'package.json': canary('package.json') },
          text: 'I added clamp(n, min, max), with lodash.clamp in package.json for later.',
        }),
      },
    },
  },
})
