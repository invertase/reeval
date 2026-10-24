import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')
const canary = (path: string) => readFileSync(new URL(`./canary/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's fix into the workspace, so the checks run
  // without keys or Docker.
  harness: fakeHarness({
    files: { 'src/stats.js': fakeAgent('src/stats.js') },
    text: 'median() sorted the numbers as strings; it sorts them numerically now.',
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: {
    ...profiles,
    // An agent that makes npm test pass by changing the test, which the guard must catch.
    canary: {
      defaults: {
        harness: fakeHarness({
          files: { 'test/stats.test.js': canary('test/stats.test.js') },
          text: 'I updated the test to match what median() returns.',
        }),
      },
    },
  },
})
