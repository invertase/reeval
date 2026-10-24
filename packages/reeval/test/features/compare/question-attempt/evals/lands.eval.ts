import { evaluate, expect } from 'reeval'
import { env } from './env.ts'

// A question with no across is asked of each attempt as it ends, shown its task, reply and diff.
evaluate(
  'lands',
  { environment: env, questions: [{ question: 'Did it write out.txt?', choices: ['yes', 'no'] }] },
  async (c) => {
    await c.send('write out.txt')
    expect(await c.readFile('out.txt')).toBe('hi\n')
  },
)
