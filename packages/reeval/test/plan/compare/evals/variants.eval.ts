import { evaluate } from 'reeval'
import { base, skilled, terse } from './envs.ts'

evaluate(
  'control and two variants',
  { environment: base, compare: { variants: [skilled, terse] } },
  async () => {},
)
evaluate(
  'every cell gated, with a minimum lift',
  { environment: base, compare: { variants: [skilled], gate: 'all', minLift: 0.2 }, runs: 2 },
  async () => {},
)
