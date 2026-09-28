import { evaluate, expect } from 'reeval'
import { present } from './env.ts'

// Must fail: a step whose cwd exists runs there.
evaluate('canary', { environment: present }, async (t) => {
  const box = await t.sandbox()
  expect(await box.readFile('sub/ran')).toBeNull()
})
