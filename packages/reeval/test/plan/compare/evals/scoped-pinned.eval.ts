import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'

evaluate(
  'pinned variant on b only',
  { compare: { control: base, variants: [skilled], harnesses: ['b'] }, pin: ['compare'] },
  async () => {},
)
