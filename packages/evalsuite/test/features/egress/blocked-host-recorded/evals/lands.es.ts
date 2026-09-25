import { evaluate, expect } from 'evalsuite'
import { agentSaw, listed } from './env.ts'

// An unlisted host gets a refusal that says why, and the attempt goes on to its checks.
evaluate('lands', { environment: listed }, async (t) => {
  const [body] = agentSaw(await t.send('fetch an unlisted host'))
  expect(body?.trim()).toBe(
    "blocked by the ES egress policy: blocked.invalid isn't in the allowlist",
  )
})
