import { evaluate, expect } from 'reeval'
import { env } from './env.ts'

// Must fail: out.txt is as the agent wrote it, not 'bye'.
evaluate(
  'canary',
  {
    environment: env,
    questions: [
      {
        question: 'Did it write out.txt?',
        choices: ['yes', 'no'],
        task: true,
        output: true,
        diff: true,
        transcript: true,
      },
    ],
  },
  async (c) => {
    await c.send('write out.txt')
    expect(await c.readFile('out.txt')).toBe('bye\n')
  },
)
