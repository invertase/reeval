import { evaluate } from 'reeval'
import { base, skilled, terse } from './envs.ts'

evaluate('two variants', { compare: { control: base, variants: [skilled, terse] } }, async () => {})
evaluate('one variant', { compare: { control: base, variants: [skilled] } }, async () => {})
evaluate(
  'pinned',
  { compare: { control: base, variants: [skilled, terse] }, pin: ['compare'] },
  async () => {},
)
