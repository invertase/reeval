import { evaluate, expect } from 'reeval'
import { next, vite } from './env.ts'

// Must fail: the filter goes by the control's traits, so the vite-app variant runs with it.
evaluate('canary', { compare: { control: next, variants: [vite] }, runs: 1 }, async (c) => {
  expect(await c.readFile('stack.txt'), 'runs on next').toBe('next')
})
