import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environments: plain }, async (c) => {
  const turn = await c.send('print thirty thousand lines')
  const shell = turn.transcript.find((e) => e.type === 'tool' && e.tool === 'shell')
  expect(shell).toMatchObject({
    outputView: 'model',
    output: expect.stringMatching(/\nline-15000\n.*END-OF-OUTPUT-77\n$/s),
  })
})
