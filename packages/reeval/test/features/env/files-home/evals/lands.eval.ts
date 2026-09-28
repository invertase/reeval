import { evaluate, expect } from 'reeval'
import { homeFiles } from './env.ts'

// A `~/` file lands in the sandbox's home directory.
evaluate('lands', { environment: homeFiles }, async (t) => {
  const box = await t.sandbox()
  expect(await box.readFile('~/.config/es/hint.txt')).toBe('from home')
})
