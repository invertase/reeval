import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('lands', { environments: plain }, async (c) => {
  const turn = await c.send('print thirty thousand lines')
  const shell = turn.transcript.find((e) => e.type === 'tool' && e.tool === 'shell')
  expect(shell).toMatchObject({
    outputView: 'model',
    outputTruncated: { bytes: 318_911 },
    output: expect.stringMatching(/^line-1\n.*\n\[… 187839 bytes cut …\]\n.*END-OF-OUTPUT-77\n$/s),
  })
})
