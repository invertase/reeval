import { evaluate, expect } from 'reeval'

// Its log line and pass reach the event stream, and reeval attach prints them as the run did.
evaluate('lands', async (c) => {
  console.log('streamed from lands')
  expect(c.attempt.n, 'first try').toBe(1)
})
