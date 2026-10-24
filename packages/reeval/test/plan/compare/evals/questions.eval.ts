import { evaluate } from 'reeval'
import { base, skilled, terse } from './envs.ts'

evaluate(
  'one question',
  {
    compare: { baseline: base, variants: [skilled] },
    questions: [{ question: 'Which handles state more cleanly?', across: 'environment' }],
  },
  async () => {},
)
evaluate(
  'two questions, one with its own model',
  {
    compare: { baseline: base, variants: [skilled, terse] },
    questions: [
      { question: 'Which handles state more cleanly?', across: ['environment', 'harness'] },
      {
        question: 'Which follows the house style more closely?',
        model: 'google/gemini-3.8-flash',
        across: 'environment',
      },
    ],
  },
  async () => {},
)
evaluate(
  'pinned',
  {
    compare: { baseline: base, variants: [skilled] },
    questions: [{ question: 'Which is shorter?', across: 'environment' }],
    pin: ['compare'],
  },
  async () => {},
)
