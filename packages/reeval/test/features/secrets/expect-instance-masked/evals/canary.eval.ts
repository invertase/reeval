import { evaluate, expect } from 'reeval'
import { Holder, TokenError } from './classes.ts'
import { plain } from './env.ts'
import { COMMAND, PASSPHRASE, TOKEN } from './token.ts'

evaluate('canary', { environments: plain }, async (c) => {
  await c.exec(...COMMAND)
  // Must fail twice, quoting each instance with a secret longer than the message cuts a value to.
  expect(new TokenError(TOKEN)).toBeNull()
  expect(new Holder(PASSPHRASE)).toBeNull()
})
