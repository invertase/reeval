import { evaluate, group } from 'reeval'
import { base, skilled } from './envs.ts'

const compare = { baseline: base, variants: [skilled] }
const across = 'environment' as const

group('reviews', { question: { model: 'google/gemini-3.8-flash' } }, () => {
  evaluate(
    'from the group',
    { compare, questions: [{ question: 'Which is cleaner?', across }] },
    async () => {},
  )
  evaluate(
    'the eval over the group',
    {
      question: { model: 'openai/gpt-5.5' },
      compare,
      questions: [{ question: 'Which is shorter?', across }],
    },
    async () => {},
  )
  evaluate(
    'the entry over both',
    {
      question: { model: 'openai/gpt-5.5' },
      compare,
      questions: [{ question: 'Which is safer?', model: 'anthropic/claude-sonnet-5', across }],
    },
    async () => {},
  )
})
evaluate(
  'no question model',
  { compare, questions: [{ question: 'Which is clearer?', across }] },
  async () => {},
)
