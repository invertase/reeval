import { evaluate, expect } from 'reeval'
import { plain, prompt, traceId } from './env.ts'

// Must fail: the agent fetched the page, so its reply has the trace id.
evaluate('canary', { environment: plain }, async (c) => {
  const turn = await c.send(prompt)
  expect(turn.text).not.toMatch(traceId)
})
