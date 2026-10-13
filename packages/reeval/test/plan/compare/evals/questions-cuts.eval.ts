import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'

evaluate(
  'within only',
  {
    compare: {
      baseline: base,
      variants: [skilled],
      questions: [{ question: 'Which handles state more cleanly?', cut: 'within' }],
    },
  },
  async () => {},
)
evaluate(
  'across from compare.cuts',
  {
    compare: {
      baseline: base,
      variants: [skilled],
      cuts: ['across'],
      questions: ['Which agent is clearer?'],
    },
  },
  async () => {},
)
evaluate(
  'question cut overrides compare.cuts',
  {
    compare: {
      baseline: base,
      variants: [skilled],
      cuts: ['across'],
      questions: [{ question: 'Which follows the house style more closely?', cut: 'within' }],
    },
  },
  async () => {},
)
