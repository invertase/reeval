import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'

evaluate.each(['ada', 'grace', 'linus'])(
  'pooled across %s',
  { compare: { baseline: base, variants: [skilled], minLift: 0.2 } },
  async () => {},
)
evaluate.each([{ who: 'ada' }, { who: 'grace' }], { pool: false })(
  'each on its own for $who',
  { compare: { baseline: base, variants: [skilled] } },
  async () => {},
)
evaluate.each(['only'])('one case is not a family: %s', async () => {})
