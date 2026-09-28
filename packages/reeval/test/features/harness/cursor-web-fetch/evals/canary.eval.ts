import { evaluate, expect } from 'evalsuite'
import { plain, prompt, traceId } from './env.ts'

// Must fail: the agent fetched the page, so its reply has the trace id.
evaluate('canary', { environment: plain }, async (t) => {
  const turn = await t.send(prompt)
  expect(turn.text).not.toMatch(traceId)
})
