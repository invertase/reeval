import { evaluate, expect } from 'reeval'
import { baseline, variant } from './env.ts'

// Must fail: the check the question is shown prints out.txt as the agent wrote it, not 'bye'.
evaluate(
  'canary',
  {
    compare: { control: baseline, variants: [variant] },
    questions: [
      {
        question: 'Which reply is clearer?',
        across: 'environment',
        output: true,
        turns: 'last',
        checks: ['cat out.txt'],
      },
    ],
  },
  async (c) => {
    await c.send('first turn')
    await c.send('second turn')
    expect((await c.exec('cat out.txt')).stdout).toBe('bye\n')
  },
)
