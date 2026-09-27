import { evaluate, expect } from 'evalsuite'

evaluate('writes greet.js', async (t) => {
  const turn = await t.send('Write greet.js')
  await expect(turn).toHaveFile('greet.js', /Hello/)
})
evaluate.todo('greets in French')
