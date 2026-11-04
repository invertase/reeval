import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environments: plain }, async (c) => {
  // The mistake: the variable is set under another name, so the command reads none.
  const r = await c.exec('printf %s "$GREETING"', { env: { GREETNG: 'hello' } })
  expect(r.stdout).toBe('hello')
})
