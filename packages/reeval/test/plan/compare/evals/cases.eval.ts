import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'

evaluate(
  'pooled',
  {
    cases: ['ada', 'grace', 'linus'],
    compare: { control: base, variants: [skilled], minLift: 0.2 },
  },
  async () => {},
)
evaluate(
  'keyed',
  {
    cases: [{ who: 'ada' }, { who: 'grace' }],
    caseKey: (c) => c.who,
    compare: { control: base, variants: [skilled] },
  },
  async () => {},
)
evaluate('one case is not pooled', { cases: ['only'] }, async () => {})
