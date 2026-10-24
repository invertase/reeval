import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace.
  harness: fakeHarness({
    files: { 'banner.sh': fakeAgent('banner.sh') },
    text: "I wrote banner.sh, which prints github.com's SSH banner.",
  }),
  // fakeSandbox() runs on the host's network, where raw TCP always works.
  sandbox: docker(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
