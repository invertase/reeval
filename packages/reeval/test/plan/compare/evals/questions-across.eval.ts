import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'

evaluate(
  'environment only',
  {
    compare: {
      baseline: base,
      variants: [skilled],
      questions: [{ question: 'Which handles state more cleanly?', across: 'environment' }],
    },
  },
  async () => {},
)
evaluate(
  'harness from compare.across',
  {
    compare: {
      baseline: base,
      variants: [skilled],
      across: 'harness',
      questions: ['Which agent is clearer?'],
    },
  },
  async () => {},
)
evaluate(
  'question across overrides compare.across',
  {
    compare: {
      baseline: base,
      variants: [skilled],
      across: ['harness'],
      questions: [
        {
          question: 'Which follows the house style more closely?',
          across: 'environment',
        },
      ],
    },
  },
  async () => {},
)
