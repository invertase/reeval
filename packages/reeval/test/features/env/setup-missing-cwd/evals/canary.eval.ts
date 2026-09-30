import { evaluate, expect } from 'reeval'
import { present } from './env.ts'

// Must fail: a step whose cwd exists runs there.
evaluate('canary', { environment: present }, async (c) => {
  const box = await c.sandbox()
  expect(await box.readFile('sub/ran')).toBeNull()
})
