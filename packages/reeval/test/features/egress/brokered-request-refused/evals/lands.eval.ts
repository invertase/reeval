import { evaluate, expect } from 'reeval'
import { agentSaw, brokered } from './env.ts'

// The brokered key off its endpoints gets the gateway's refusal, which says why.
evaluate('lands', { environment: brokered }, async (c) => {
  const [body] = agentSaw(await c.send('search the web'))
  expect(body?.trim()).toBe(
    "reeval egress gateway: refused POST https://api.openai.com/v1/alpha/search. It carries a brokered credential, and it isn't one of the endpoints reeval brokers it for.",
  )
})
