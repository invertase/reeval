import { evaluate, expect } from 'evalsuite'
import { closed, reach } from './env.ts'

// Must fail: any other host is refused at CONNECT, with no turn needed.
evaluate('canary', { environment: closed }, async (t) => {
  await t.sandbox()
  await t.exec(reach('registry.npmjs.org'))
  expect((await t.readFile('reached.txt'))?.trim()).toMatch(/^200 \d{3}$/)
})
