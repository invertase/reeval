import { evaluate, expect } from 'reeval'
import { closed } from './env.ts'

// An expected host is still refused at CONNECT; only how reeval reports it changes.
evaluate('lands', { environments: closed }, async (c) => {
  await c.send('call home')
  expect((await c.readFile('reached.txt'))?.trim()).toBe('403 000')
})
