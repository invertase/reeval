import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')
const files = { 'src/math.js': fakeAgent('src/math.js') }

export default defineConfig({
  include: ['*.eval.ts'],
  // Two scripted agents that copy ./fake-agent's files into the workspace, so each eval has a
  // list of harnesses to edit, without keys or Docker.
  harness: [
    fakeHarness({ id: 'fake-quick', files }),
    fakeHarness({ id: 'fake-careful', script: [[{ exec: 'node --test' }]], files }),
  ],
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
