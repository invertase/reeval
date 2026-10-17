import { evaluate, expect } from 'reeval'
import { homeFiles } from './env.ts'

// A `~/` file lands in the sandbox's home directory.
evaluate('lands', { environment: homeFiles }, async (c) => {
  const box = await c.sandbox()
  expect(await box.readFile('~/.config/reeval/hint.txt')).toBe('from home')
})
