import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'

// Without across, a question is asked of each attempt on its own, with or without a compare.
evaluate(
  'asked of each attempt',
  { questions: ['How did the agent find the failing test?'] },
  async () => {},
)
evaluate(
  'with choices',
  {
    runs: 2,
    gate: { passRate: 0.5 },
    questions: [{ question: 'Did the agent run the tests first?', choices: ['yes', 'no'] }],
  },
  async () => {},
)
evaluate(
  'beside a compare',
  {
    compare: { baseline: base, variants: [skilled] },
    questions: [
      'What did the agent read first?',
      { question: 'Which is cleaner?', across: 'environment' },
    ],
  },
  async () => {},
)
evaluate(
  'across harnesses without a compare',
  { questions: [{ question: 'Which agent explained its change better?', across: 'harness' }] },
  async () => {},
)
