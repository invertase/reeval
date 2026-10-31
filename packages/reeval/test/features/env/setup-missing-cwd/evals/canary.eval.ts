import { evaluate, expect } from 'reeval'
import { present } from './env.ts'

// Must fail: a step whose cwd exists runs there.
evaluate('canary', { environments: present }, async (c) => {
  expect(await c.readFile('sub/ran')).toBeNull()
})
