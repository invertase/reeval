import { evaluate, expect, group } from 'reeval'

group('docs', () => {
  evaluate('writes a README', async (c) => {
    const turn = await c.send('Write README.md explaining how to add a note with notes.js.')
    await expect.soft(turn, 'README exists').toHaveFile('README.md', /notes\.js add/)
    const verdict = await c.judge('Does the README explain how to add a note?', {
      contents: ['README.md'],
      threshold: 0.95,
    })
    expect.soft(verdict, 'explains adding a note').toPass()
  })
})
