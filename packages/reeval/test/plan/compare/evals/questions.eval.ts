import { evaluate } from 'reeval'
import { base, skilled, terse } from './envs.ts'

evaluate(
  'one question',
  {
    compare: {
      baseline: base,
      variants: [skilled],
      questions: ['Which handles state more cleanly?'],
    },
  },
  async () => {},
)
evaluate(
  'two questions, one with its own model',
  {
    compare: {
      baseline: base,
      variants: [skilled, terse],
      questions: [
        'Which handles state more cleanly?',
        {
          question: 'Which follows the house style more closely?',
          model: 'google/gemini-3.8-flash',
        },
      ],
    },
  },
  async () => {},
)
evaluate(
  'pinned',
  {
    compare: { baseline: base, variants: [skilled], questions: ['Which is shorter?'] },
    pin: ['compare'],
  },
  async () => {},
)
