import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'

evaluate(
  'transcript across harnesses',
  {
    compare: { baseline: base, variants: [skilled] },
    questions: [
      {
        question: 'Which agent verified its work?',
        across: 'harness',
        transcript: 'tools',
      },
    ],
  },
  async () => {},
)
evaluate(
  'transcript within a harness',
  {
    compare: { baseline: base, variants: [skilled] },
    questions: [
      {
        question: 'Which arm verified its work?',
        across: 'environment',
        transcript: 'tools',
      },
    ],
  },
  async () => {},
)
evaluate(
  'screenshots',
  {
    compare: { baseline: base, variants: [skilled] },
    questions: [
      { question: 'Which page looks better?', across: 'environment', artifacts: ['landing'] },
    ],
  },
  async () => {},
)
evaluate(
  'each attempt with the transcript',
  {
    questions: [
      {
        question: 'What did the agent check before it finished?',
        task: true,
        output: true,
        diff: true,
        transcript: true,
      },
    ],
  },
  async () => {},
)
evaluate(
  'each attempt without the transcript',
  {
    questions: [
      { question: 'What did the agent say it did?', task: true, output: true, diff: true },
    ],
  },
  async () => {},
)
