import { evaluate, expect } from 'reeval'
import { hidden } from './env.ts'

// A trait is for where: its value is in no workspace file, variable or prompt.
evaluate('lands', { environments: hidden }, async (c) => {
  await c.send('Look around.')
  const found = await c.exec('grep -rl trait-zx81 . ; env | grep -c trait-zx81 || true')
  expect(found.stdout.trim(), 'the trait is hidden').toBe('0')
})
