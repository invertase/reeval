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
  // A scripted agent that copies ./fake-agent's tests into the workspace, so the checks run
  // without keys or Docker.
  harnesses: fakeHarness({
    files: { 'test/duration.test.js': fakeAgent('test/duration.test.js') },
    text: 'I added tests for single units, combined units and invalid input.',
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: {
    ...profiles,
    // An agent whose one test passes and misses the mutant, which the mutant check must catch.
    canary: {
      defaults: {
        harnesses: fakeHarness({
          files: { 'test/duration.test.js': canary('test/duration.test.js') },
          text: 'I added a test for parseDuration.',
        }),
      },
    },
  },
})
