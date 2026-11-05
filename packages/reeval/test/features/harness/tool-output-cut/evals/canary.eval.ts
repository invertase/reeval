import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environments: plain }, async (c) => {
  const turn = await c.send('print thirty thousand lines')
  const shell = turn.transcript.find((e) => e.type === 'tool' && e.tool === 'shell')
  // The transcript cuts the middle of the output, so line-15000 isn't in it.
  expect(shell?.type === 'tool' && shell.output).toContain('line-15000\n')
})
