import { evaluate, expect } from 'evalsuite'
import { closed } from './env.ts'

// An expected host is still refused at CONNECT; only how ES reports it changes.
evaluate('lands', { environment: closed }, async (t) => {
  await t.send('call home')
  expect((await t.readFile('reached.txt'))?.trim()).toBe('403 000')
})
