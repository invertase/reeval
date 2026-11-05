import { evaluate } from 'reeval'
import { plain } from './env.ts'

// A turn the provider stopped for credit fails the attempt as an infra error (features.test.ts
// checks the message and the record's `provider`), even when the body catches it; a turn that
// failed otherwise, the first, doesn't.
evaluate('lands', { environments: plain }, async (c) => {
  await c.send('Reply with the word hi.')
  await c.send('Reply with the word hi.').catch(() => {})
})
