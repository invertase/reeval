import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace, and a judge with a
  // fixed score, so the checks run without keys or Docker.
  harnesses: fakeHarness({
    files: {
      'src/parse.js': fakeAgent('src/parse.js'),
      'src/users.js': fakeAgent('src/users.js'),
      'src/orders.js': fakeAgent('src/orders.js'),
    },
    text: 'I moved the parsing into parseRecord() in src/parse.js; users.js and orders.js use it.',
  }),
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: 0.9 }) },
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
