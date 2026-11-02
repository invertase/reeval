// The skill topic's oracle: a fake agent that applies oracle/'s known-good answer to each task,
// so every check must pass (the shared reeval.fake.config.ts is the canary: every check fails).
// `pnpm reeval run --config evals/skill/reeval.oracle.config.ts`, after `node evals/skill/scripts/vendor.mjs`.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

const solve = fileURLToPath(new URL('./oracle/solve.mjs', import.meta.url))

export default defineConfig({
  include: ['*.eval.ts'],
  harnesses: fakeHarness({
    script: [[{ exec: `node ${solve}` }]],
    text:
      'Fixed: compare moved out of the config, the environment list became compare, repeat ' +
      'became runs, and I added the missing await. The check that failed was `trims punctuation`.',
  }),
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: 0.9 }) },
  analysis: { model: fakeAnalysis({ vote: 'tie' }) },
  timeout: '10m',
})
