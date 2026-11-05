import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environments: plain }, async (c) => {
  const turn = await c.send('print thirty thousand lines')
  const shell = turn.transcript.find((e) => e.type === 'tool' && e.tool === 'shell')
  // The fake agent's shell output is what its model saw, not the full view.
  expect(shell).toMatchObject({
    outputView: 'full',
    output: expect.stringMatching(/\nline-15000\n.*END-OF-OUTPUT-77\n$/s),
  })
})
