import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'

evaluate(
  'environment only',
  {
    compare: { baseline: base, variants: [skilled] },
    questions: [
      { question: 'Which handles state more cleanly?', across: 'environment', diff: true },
    ],
  },
  async () => {},
)
evaluate(
  'harness only',
  {
    compare: { baseline: base, variants: [skilled] },
    questions: [{ question: 'Which agent is clearer?', across: 'harness', diff: true }],
  },
  async () => {},
)
evaluate(
  'both factors',
  {
    compare: { baseline: base, variants: [skilled] },
    questions: [
      {
        question: 'Which follows the house style more closely?',
        across: ['environment', 'harness'],
        diff: true,
      },
    ],
  },
  async () => {},
)
