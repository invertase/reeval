import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that applies ./fake-agent's patch to the checkout with git, so the checks
  // run without keys or Docker.
  harnesses: fakeHarness({
    script: [
      [
        { write: { 'separators.patch': fakeAgent('separators.patch') } },
        { exec: 'git apply separators.patch && rm separators.patch' },
        { exec: 'node --test' },
        { reply: 'camelCase takes a separators option now, with a test and a readme section.' },
      ],
    ],
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
