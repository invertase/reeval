// The quick-start topic's oracle: a fake agent that asks first, then sets reeval up the way the
// skill says (oracle/solve.sh), so every check must pass. `--profile canary` is a fake agent that
// sets up without asking and forces init, so the asking, doctor and overwrite checks must fail.
// In real Docker (`reeval image build --config …`), after `node evals/skill/scripts/vendor.mjs`.
import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'

const solve = readFileSync(new URL('./oracle/solve.sh', import.meta.url), 'utf8')
const handover =
  'Added reeval.config.ts and one eval. Add CURSOR_API_KEY=... to .env.local, then run ' +
  '`npx reeval image build` and `npx reeval run`.'

export default defineConfig({
  include: ['*.eval.ts'],
  harness: fakeHarness({
    script: [
      [{ reply: 'This repo has skills. Shall I set up evals for this project?' }],
      [{ exec: solve }, { reply: handover }],
    ],
  }),
  judge: { model: fakeJudge({ score: 0.9 }) },
  analysis: { model: fakeAnalysis({ vote: 'tie' }) },
  timeout: '10m',
  profiles: {
    canary: {
      defaults: {
        harness: fakeHarness({
          script: [
            [
              {
                exec: 'npm init -y >/dev/null; npm i -D ~/reeval.tgz --no-audit --no-fund --loglevel=error',
              },
              { exec: 'npx reeval init --harness cursor --force' },
              { write: { 'skills/README.md': 'Replaced.\n' } },
              { reply: 'Done.' },
            ],
            [{ reply: 'Done.' }],
          ],
        }),
      },
    },
  },
})
