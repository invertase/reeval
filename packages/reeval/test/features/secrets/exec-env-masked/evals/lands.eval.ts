import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'
import { TOKEN } from './token.ts'

// The command prints a secret-named value it was given; the oracle finds it nowhere reeval wrote.
evaluate('lands', { environments: plain }, async (c) => {
  const r = await c.exec('printf %s "$EXEC_TOKEN"', { env: { EXEC_TOKEN: TOKEN } })
  console.log(r.stdout)
  expect(r.stdout).toBe(TOKEN)
})
