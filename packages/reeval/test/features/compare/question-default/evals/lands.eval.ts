import { evaluate, expect } from 'reeval'
import { baseline, variant } from './env.ts'

// A question with no state is shown the task and the diff: out.txt, not the agent's reply.
evaluate(
  'lands',
  {
    compare: { baseline, variants: [variant] },
    questions: [{ question: 'Which out.txt is better?', across: 'environment' }],
  },
  async (c) => {
    await c.send('write out.txt')
    expect(await c.readFile('out.txt')).toBe('hi\n')
  },
)
