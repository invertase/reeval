import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that runs the prompt's command in the sandbox, as a real agent would.
  harness: fakeHarness({
    script: [[{ exec: 'env | sort > env.txt' }, { reply: 'env.txt has the environment.' }]],
  }),
  // fakeSandbox() runs everything on the host, so its agent would see the token too.
  sandbox: docker(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
