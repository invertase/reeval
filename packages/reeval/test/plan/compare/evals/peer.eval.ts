import { evaluate } from 'reeval'
import { base, skilled, terse } from './envs.ts'

evaluate(
  'peer challengers vs base',
  { environment: base, compare: { strategy: 'peer', variants: [skilled, terse] } },
  async () => {},
)
