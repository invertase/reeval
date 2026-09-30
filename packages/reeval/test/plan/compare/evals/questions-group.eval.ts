import { evaluate, group } from 'reeval'
import { base, skilled, terse } from './envs.ts'

// Each eval that keeps the group's compare asks its question; one that replaces compare doesn't.
group(
  'asked by the group',
  {
    compare: {
      baseline: base,
      variants: [skilled],
      questions: ['Which handles state more cleanly?'],
    },
  },
  () => {
    evaluate('inherits the question', async () => {})
    evaluate('also inherits it', { runs: 2, gate: { passRate: 0.5 } }, async () => {})
    evaluate(
      'replaces the compare',
      { compare: { baseline: base, variants: [terse] } },
      async () => {},
    )
  },
)
