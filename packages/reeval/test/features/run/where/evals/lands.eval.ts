import { evaluate, expect } from 'reeval'
import { next, vite } from './env.ts'

// Each case runs only on the environment whose stack it names.
evaluate(
  'lands',
  {
    environments: [next, vite],
    cases: ['next', 'vite'],
    where: ({ case: stack, environment }) => environment.traits.stack === stack,
  },
  async (c, stack) => {
    expect(await c.readFile('stack.txt'), 'runs on its own stack').toBe(stack)
  },
)
