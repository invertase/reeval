import { evaluate, expect } from 'evalsuite'
import { closed } from './env.ts'

// Must fail: expecting a host doesn't let it through.
evaluate('canary', { environment: closed }, async (t) => {
  await t.send('call home')
  expect((await t.readFile('reached.txt'))?.trim()).toMatch(/^200 \d{3}$/)
})
