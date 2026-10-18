import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'

evaluate(
  'transcript across harnesses',
  {
    compare: {
      baseline: base,
      variants: [skilled],
      questions: [{ question: 'Which agent verified its work?', state: { transcript: 'tools' } }],
    },
  },
  async () => {},
)
evaluate(
  'transcript within a harness',
  {
    compare: {
      baseline: base,
      variants: [skilled],
      questions: [
        {
          question: 'Which arm verified its work?',
          across: 'environment',
          state: { transcript: 'tools' },
        },
      ],
    },
  },
  async () => {},
)
evaluate(
  'screenshots',
  {
    question: { state: { diff: false } },
    compare: {
      baseline: base,
      variants: [skilled],
      questions: [{ question: 'Which page looks better?', artifacts: ['landing'] }],
    },
  },
  async () => {},
)
