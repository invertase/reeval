import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // Any secret the sandbox would get as its real value stops the run before it starts.
  secrets: { unbrokered: 'error' },
  // A scripted agent that copies ./fake-agent's files into the workspace.
  harnesses: fakeHarness({
    files: { 'repo.js': fakeAgent('repo.js') },
    text: "I wrote repo.js, which prints the repo's description.",
  }),
  // fakeSandbox() brokers nothing, so it doesn't apply the secrets rule either.
  sandbox: docker(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
