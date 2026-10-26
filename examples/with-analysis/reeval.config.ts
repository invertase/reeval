import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'
import { output } from './fake-analysis.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace, so the checks run
  // without keys or Docker.
  harness: fakeHarness({
    files: {
      'src/math.js': fakeAgent('src/math.js'),
      'test/math.test.js': fakeAgent('test/math.test.js'),
    },
    text: 'I added multiply(a, b) to src/math.js and a test for it.',
  }),
  sandbox: fakeSandbox(),
  // A canned analysis model from ./fake-analysis.ts, so `reeval analyze` needs no key. Profiles can't set it: for a real one, use a model such as 'anthropic/claude-sonnet-5'.
  analysis: { model: fakeAnalysis({ output }) },
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
