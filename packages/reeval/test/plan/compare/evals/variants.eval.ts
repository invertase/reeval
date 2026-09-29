import { evaluate } from 'reeval'
import { base, skilled, terse } from './envs.ts'

evaluate(
  'control and two variants',
  { compare: { baseline: base, variants: [skilled, terse] } },
  async () => {},
)
evaluate(
  'every cell gated, with a minimum lift',
  { compare: { baseline: base, variants: [skilled], gate: 'all', minLift: 0.2 }, runs: 2 },
  async () => {},
)
