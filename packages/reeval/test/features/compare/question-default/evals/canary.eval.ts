import { evaluate, expect } from 'reeval'
import { baseline, variant } from './env.ts'

// Must fail: the diff the question is shown has out.txt as the agent wrote it, not 'bye'.
evaluate(
  'canary',
  {
    compare: { baseline, variants: [variant] },
    questions: [{ question: 'Which out.txt is better?', across: 'environment' }],
  },
  async (c) => {
    await c.send('write out.txt')
    expect(await c.readFile('out.txt')).toBe('bye\n')
  },
)
