import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'

evaluate(
  'variant on b only',
  { compare: { baseline: base, variants: [skilled], harness: ['b'] } },
  async () => {},
)
