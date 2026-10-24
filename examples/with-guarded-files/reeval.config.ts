import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's fix into the workspace, so the checks run
  // without keys or Docker.
  harness: fakeHarness({
    files: { 'src/range.js': fakeAgent('src/range.js') },
    text: 'range(n) counted to n inclusive; I fixed the loop bound in src/range.js.',
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: {
    ...profiles,
    // A fake agent that makes the test pass by rewriting it, which the guard must catch.
    cheat: {
      defaults: {
        harness: fakeHarness({
          files: { 'test/range.test.js': fakeAgent('test/range.test.js') },
          text: 'I updated the test to match what range(n) returns.',
        }),
      },
    },
  },
})
