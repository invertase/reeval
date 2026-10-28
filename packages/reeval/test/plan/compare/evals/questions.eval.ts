import { evaluate } from 'reeval'
import { base, skilled, terse } from './envs.ts'

evaluate(
  'one question',
  {
    compare: { baseline: base, variants: [skilled] },
    questions: [
      { question: 'Which handles state more cleanly?', across: 'environment', diff: true },
    ],
  },
  async () => {},
)
evaluate(
  'two questions, one with its own model',
  {
    compare: { baseline: base, variants: [skilled, terse] },
    questions: [
      {
        question: 'Which handles state more cleanly?',
        across: ['environment', 'harness'],
        diff: true,
      },
      {
        question: 'Which follows the house style more closely?',
        model: 'google/gemini-3.8-flash',
        across: 'environment',
        diff: true,
      },
    ],
  },
  async () => {},
)
evaluate(
  'pinned',
  {
    compare: { baseline: base, variants: [skilled] },
    questions: [{ question: 'Which is shorter?', across: 'environment', diff: true }],
    pin: ['compare'],
  },
  async () => {},
)
