import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace. The environment's
  // Dockerfile sandbox still applies, so even the fake agent runs in Docker.
  harnesses: fakeHarness({
    files: { 'report.sql': fakeAgent('report.sql') },
    text: 'I wrote report.sql, which lists the customers by name.',
  }),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
