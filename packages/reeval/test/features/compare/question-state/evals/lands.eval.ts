import { evaluate, expect } from 'reeval'
import { baseline, variant } from './env.ts'

// The inputs pick the parts: the last turn's reply and one check's result, no diff and no first turn.
evaluate(
  'lands',
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
    await c.exec('echo unshown')
    expect((await c.exec('cat out.txt')).stdout).toBe('hi\n')
  },
)
