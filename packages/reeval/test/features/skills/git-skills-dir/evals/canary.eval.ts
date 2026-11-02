import { evaluate, expect } from 'reeval'
import { greeting, staged } from './env.ts'

// Must fail: the staged skill greets with "Ahoy", not "Hello there".
evaluate('canary', { environments: greeting }, async (c) => {
  expect(await c.readFile(staged)).toContain('Hello there, <name>.')
})
