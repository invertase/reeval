import { evaluate, expect } from 'reeval'
import { closed, reach } from './env.ts'

// Must fail: any other host is refused at CONNECT, with no turn needed.
evaluate('canary', { environment: closed }, async (c) => {
  await c.sandbox()
  await c.exec(reach('registry.npmjs.org'))
  expect((await c.readFile('reached.txt'))?.trim()).toMatch(/^200 \d{3}$/)
})
