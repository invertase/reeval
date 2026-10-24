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
        state: { transcript: 'tools' },
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
        state: { transcript: 'tools' },
      },
    ],
  },
  async () => {},
)
evaluate(
  'screenshots',
  {
    question: { state: { diff: false } },
    compare: { baseline: base, variants: [skilled] },
    questions: [
      { question: 'Which page looks better?', across: 'environment', artifacts: ['landing'] },
    ],
  },
  async () => {},
)
evaluate(
  'each attempt by default',
  { questions: ['What did the agent check before it finished?'] },
  async () => {},
)
evaluate(
  'each attempt without the transcript',
  { questions: [{ question: 'What did the agent say it did?', state: { transcript: false } }] },
  async () => {},
)
