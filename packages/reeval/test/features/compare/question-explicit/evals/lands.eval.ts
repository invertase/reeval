import { evaluate, expect } from 'reeval'
import { baseline, variant } from './env.ts'

// A question is shown only the inputs it turns on: the diff, with no task and no reply.
evaluate(
  'lands',
  {
    compare: { control: baseline, variants: [variant] },
    questions: [{ question: 'Which out.txt is better?', across: 'environment', diff: true }],
  },
  async (c) => {
    await c.send('write out.txt')
    expect(await c.readFile('out.txt')).toBe('hi\n')
  },
)
