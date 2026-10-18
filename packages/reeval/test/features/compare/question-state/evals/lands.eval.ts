import { evaluate, expect } from 'reeval'
import { baseline, variant } from './env.ts'

// state picks the parts: the last turn's reply and one check's result, no diff and no first turn.
evaluate(
  'lands',
  {
    compare: {
      baseline,
      variants: [variant],
      questions: [
        {
          question: 'Which reply is clearer?',
          state: { diff: false, output: true, turns: 'last', checks: ['cat out.txt'] },
        },
      ],
    },
  },
  async (c) => {
    await c.send('first turn')
    await c.send('second turn')
    await c.exec('echo unshown')
    expect((await c.exec('cat out.txt')).stdout).toBe('hi\n')
  },
)
