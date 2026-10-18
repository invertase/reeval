import { evaluate, group } from 'reeval'
import { base, skilled } from './envs.ts'

const compare = (questions: Array<string | { question: string; model: string }>) => ({
  baseline: base,
  variants: [skilled],
  across: 'environment' as const,
  questions,
})

group('reviews', { question: { model: 'google/gemini-3.8-flash' } }, () => {
  evaluate('from the group', { compare: compare(['Which is cleaner?']) }, async () => {})
  evaluate(
    'the eval over the group',
    { question: { model: 'openai/gpt-5.5' }, compare: compare(['Which is shorter?']) },
    async () => {},
  )
  evaluate(
    'the entry over both',
    {
      question: { model: 'openai/gpt-5.5' },
      compare: compare([{ question: 'Which is safer?', model: 'anthropic/claude-sonnet-5' }]),
    },
    async () => {},
  )
})
evaluate('no question model', { compare: compare(['Which is clearer?']) }, async () => {})
