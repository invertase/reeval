import { evaluate, expect } from 'evalsuite'
import { pinned, staged } from './env.ts'

// Must fail: main's newer greeting isn't what the v1 tag holds.
evaluate('canary', { environment: pinned }, async (t) => {
  await t.send('noop')
  expect(await t.readFile(staged)).toContain('Hello there, <name>.')
})
