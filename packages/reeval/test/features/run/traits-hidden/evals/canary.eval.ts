import { evaluate, expect } from 'reeval'
import { leaked } from './env.ts'

// Must fail: its environment writes the trait's value to a file, which the grep finds.
evaluate('canary', { environments: leaked }, async (c) => {
  await c.send('Look around.')
  const found = await c.exec('grep -rl trait-zx81 . ; env | grep -c trait-zx81 || true')
  expect(found.stdout.trim(), 'the trait is hidden').toBe('0')
})
