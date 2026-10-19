import { join } from 'node:path'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

const solve = join(import.meta.dirname, 'scripts/solve.mjs')
const oracle = fakeHarness({
  script: [[{ exec: `node ${solve}` }]],
  text: 'Fixed the eval files.',
})
export default defineConfig({
  harness: oracle,
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: 0.9 }) },
})
