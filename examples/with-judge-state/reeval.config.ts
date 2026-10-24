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
  // A scripted agent that runs the tests, then copies ./fake-agent's files into the workspace,
  // so the checks run without keys or Docker.
  harness: fakeHarness({
    script: [[{ exec: 'node --test' }]],
    files: {
      'src/math.js': fakeAgent('src/math.js'),
      'README.md': fakeAgent('README.md'),
    },
    text: 'I added multiply(a, b) to src/math.js and listed it in README.md.',
  }),
  sandbox: fakeSandbox(),
  // A fixed score and no model call; each profile sets its own judge model, which wins.
  judge: { model: fakeJudge({ score: 0.9 }) },
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
