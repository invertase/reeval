import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace. The environment's
  // Python sandbox still applies, so even the fake agent runs in Docker.
  harness: fakeHarness({
    files: {
      'fizzbuzz.py': fakeAgent('fizzbuzz.py'),
      'test_fizzbuzz.py': fakeAgent('test_fizzbuzz.py'),
    },
    text: 'I wrote fizzbuzz.py and its unittest tests in test_fizzbuzz.py.',
  }),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
