import { evaluate } from 'reeval'
import { base, skilled, terse } from './envs.ts'

evaluate(
  'two variants',
  { compare: { baseline: base, variants: [skilled, terse] } },
  async () => {},
)
evaluate('one variant', { compare: { baseline: base, variants: [skilled] } }, async () => {})
evaluate(
  'pinned',
  { compare: { baseline: base, variants: [skilled, terse] }, pin: ['compare'] },
  async () => {},
)
