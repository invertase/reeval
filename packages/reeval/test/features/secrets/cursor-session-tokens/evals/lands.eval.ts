import { evaluate, expect } from 'reeval'
import { plain, signature } from './env.ts'

// After a real turn, a session token the exchange hands the container is a placeholder: the
// gateway keeps the real one on the host.
evaluate('lands', { environments: plain }, async (c) => {
  await c.send('Reply with the single word OK.')
  expect(await signature(c.exec)).toMatch(/^reeval_secret_/)
})
