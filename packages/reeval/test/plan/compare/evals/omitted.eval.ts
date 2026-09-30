import { evaluate, group } from 'reeval'
import { base, skilled } from './envs.ts'

// Without a baseline, the control is the cascaded environment, else an empty one named baseline.
evaluate('no environment', { compare: { variants: [skilled] } }, async () => {})
group('inherits', { environment: base }, () => {
  evaluate('the group environment', { compare: { variants: [skilled] } }, async () => {})
})
evaluate(
  'its own environment',
  { environment: base, compare: { variants: [skilled] } },
  async () => {},
)
