import { evaluate, expect } from 'reeval'
import { plain, signature } from './env.ts'

// After a real turn, a session token the exchange hands the container is a placeholder: the
// gateway keeps the real one on the host.
evaluate('lands', { environment: plain }, async (t) => {
  await t.send('Reply with the single word OK.')
  expect(await signature(t.exec)).toMatch(/^reeval_secret_/)
})
