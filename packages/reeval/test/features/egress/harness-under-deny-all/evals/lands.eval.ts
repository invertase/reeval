import { evaluate, expect } from 'evalsuite'
import { closed, prompt } from './env.ts'

// Under deny-all the harness's own hosts stay allowed: the agent works, and reaches its API.
evaluate('lands', { environment: closed }, async (t) => {
  await t.send(prompt)
  expect((await t.readFile('reached.txt'))?.trim()).toMatch(/^200 \d{3}$/)
})
