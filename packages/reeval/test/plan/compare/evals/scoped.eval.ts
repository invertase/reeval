import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'

evaluate(
  'variant on b only',
  { compare: { control: base, variants: [skilled], harnesses: ['b'] } },
  async () => {},
)
