import { evaluate, expect } from 'reeval'

evaluate('writes greet.js', async (c) => {
  const turn = await c.send('Write greet.js exporting greet(name).')
  await expect(turn).toHaveFile('greet.js', /Hello/)
  expect(await c.judge('Does greet.js export greet?')).toPass()
})

evaluate('fails its check', async (c) => {
  await c.send('Write greet.js that greets in French.')
  await expect(c.exec('grep -q Bonjour greet.js')).toSucceed()
})

evaluate('fails its judge', async (c) => {
  await c.send('Write greet.js.')
  expect(await c.judge('Is greet.js perfect?', { threshold: 0.95 })).toPass()
})

evaluate.skip('is skipped for now', async (c) => {
  await c.send('Write nothing.')
})

evaluate.todo('greets in Welsh')
