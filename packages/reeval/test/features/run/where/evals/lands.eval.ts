import { evaluate, expect } from 'reeval'
import { next, vite } from './env.ts'

// Each case runs only on the environment whose stack it names, so astro runs nowhere.
evaluate(
  'lands',
  {
    environments: [next, vite],
    cases: ['next', 'vite', 'astro'],
    where: ({ case: stack, environment }) => environment.traits.stack === stack,
  },
  async (c, stack) => {
    expect(await c.readFile('stack.txt'), 'runs on its own stack').toBe(stack)
  },
)
