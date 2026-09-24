// The concurrency benchmark: the coding evals over a two-environment matrix with two runs each
// (16 attempts). Compare wall time with `es run --config es.bench.config.ts --concurrency N`.
import { baseline, defineConfig } from 'evalsuite'
import { cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'
import { withHouseGreeting } from './evals/environments.ts'

export default defineConfig({
  include: ['evals/hello.es.ts', 'evals/skill.es.ts', 'evals/python.es.ts'],
  harness: cursor({ model: 'composer-2.5' }),
  sandbox: docker(),
  environment: [baseline, withHouseGreeting],
  runs: 2,
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
})
