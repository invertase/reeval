import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// `env` sets a variable for this command only.
evaluate('lands', { environments: plain }, async (c) => {
  const r = await c.exec('printf %s "$GREETING"', { env: { GREETING: 'hello' } })
  expect(r.stdout).toBe('hello')
})
