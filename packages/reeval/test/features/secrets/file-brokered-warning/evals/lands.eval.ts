import { evaluate, expect } from 'reeval'
import { agentSaw, keys } from './env.ts'

// A brokered secret's placeholder goes out where it isn't swapped in; the listener still answers.
evaluate('lands', { environments: keys }, async (c) => {
  const [key, body] = agentSaw(await c.send('send the keys'))
  expect([key?.slice(0, 14), body]).toEqual(['reeval_secret_', 'reeval-egress-ok'])
})
