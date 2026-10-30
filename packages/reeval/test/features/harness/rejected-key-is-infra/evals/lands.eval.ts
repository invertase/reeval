import { evaluate } from 'reeval'
import { plain } from './env.ts'

// A turn whose key the API rejected fails the attempt as an infra error naming the variable
// (features.test.ts checks the message), even when the body catches it; a turn that failed
// otherwise, the first, doesn't.
evaluate('lands', { environment: plain }, async (c) => {
  await c.send('Reply with the word hi.')
  await c.send('Reply with the word hi.').catch(() => {})
})
