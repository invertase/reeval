import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace. The environments'
  // sandboxes still apply, so even the fake agent runs on Boat and Daytona.
  harnesses: fakeHarness({
    files: {
      'fizzbuzz.dart': fakeAgent('fizzbuzz.dart'),
      'fizzbuzz_test.dart': fakeAgent('fizzbuzz_test.dart'),
    },
    text: 'I wrote fizzbuzz.dart and its checks in fizzbuzz_test.dart.',
  }),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
