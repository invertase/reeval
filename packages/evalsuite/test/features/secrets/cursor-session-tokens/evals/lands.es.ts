import { evaluate, expect } from 'evalsuite'
import { plain, signature } from './env.ts'

// After a real turn, the session token the CLI stored is a placeholder: the real one never entered.
evaluate('lands', { environment: plain }, async (t) => {
  await t.send('Reply with the single word OK.')
  expect(await signature(t.readFile)).toMatch(/^es_secret_/)
})
