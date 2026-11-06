import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'
import { COMMAND, PASSPHRASE } from './token.ts'

evaluate('canary', { environments: plain }, async (c) => {
  const r = await c.exec(...COMMAND)
  // Must fail, quoting the token and the passphrase, both longer than the message cuts a value to.
  expect(r.stdout).toBe(PASSPHRASE)
})
