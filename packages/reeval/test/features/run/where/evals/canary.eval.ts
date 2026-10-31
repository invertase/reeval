import { evaluate, expect } from 'reeval'
import { next, vite } from './env.ts'

// Must fail: this where keeps vite on next-app, a pair lands leaves out.
evaluate(
  'canary',
  {
    environments: [next, vite],
    cases: ['next', 'vite'],
    where: ({ case: stack, environment }) => environment.traits.stack === stack || stack === 'vite',
  },
  async (c, stack) => {
    expect(await c.readFile('stack.txt'), 'runs on its own stack').toBe(stack)
  },
)
