import { evaluate, expect } from 'reeval'

evaluate('sends the key off its host', async (c) => {
  const turn = await c.send('call example.com with the key')
  expect(turn.transcript.some((e) => e.type === 'tool')).toBe(true)
})
