import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'

// Without across, a question is asked of each attempt on its own, with or without a compare.
evaluate(
  'asked of each attempt',
  { questions: [{ question: 'How did the agent find the failing test?', transcript: true }] },
  async () => {},
)
evaluate(
  'with choices',
  {
    runs: 2,
    gate: { passRate: 0.5 },
    questions: [
      {
        question: 'Did the agent run the tests first?',
        choices: ['yes', 'no'],
        transcript: 'tools',
      },
    ],
  },
  async () => {},
)
evaluate(
  'beside a compare',
  {
    compare: { baseline: base, variants: [skilled] },
    questions: [
      { question: 'What did the agent read first?', transcript: 'tools' },
      { question: 'Which is cleaner?', across: 'environment', diff: true },
    ],
  },
  async () => {},
)
evaluate(
  'across harnesses without a compare',
  {
    questions: [
      { question: 'Which agent explained its change better?', across: 'harness', diff: true },
    ],
  },
  async () => {},
)
