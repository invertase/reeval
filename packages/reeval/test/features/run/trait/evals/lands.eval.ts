import { evaluate, expect } from 'reeval'
import { next, vite } from './env.ts'

// Run with --trait stack=next: the vite-app cell is left out, so only next-app runs.
evaluate('lands', { environments: [next, vite] }, async (c) => {
  expect(await c.readFile('stack.txt'), 'runs on next').toBe('next')
})
