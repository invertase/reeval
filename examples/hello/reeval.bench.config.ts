// The concurrency benchmark: the coding evals with two runs per cell (hello's two evals, the
// skill eval's control and variant, and the Python eval: 10 attempts). Compare wall time with
// `reeval run --config reeval.bench.config.ts --concurrency N`.
import { defineConfig } from 'reeval'
import { docker } from 'reeval/sandbox'
import { composer } from './evals/harnesses.ts'

export default defineConfig({
  include: ['evals/hello.eval.ts', 'evals/skill.eval.ts', 'evals/python.eval.ts'],
  harness: composer,
  sandbox: docker(),
  runs: 2,
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
})
