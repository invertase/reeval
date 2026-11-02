import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace, so the checks run
  // without keys or Docker.
  harnesses: fakeHarness({
    files: {
      'src/math.js': fakeAgent('src/math.js'),
      'test/math.test.js': fakeAgent('test/math.test.js'),
    },
    text: 'I added multiply(a, b) to src/math.js and a test for it.',
  }),
  sandbox: fakeSandbox(),
  // In CI the run is recorded and `pr` applies: Claude Code in Docker, one attempt per cell.
  record: 'ci',
  defaultProfile: { ci: 'pr' },
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: {
    ...profiles,
    pr: { ...profiles['claude-code'], limit: { runs: 1 }, budget: { attempts: 20 } },
  },
})
