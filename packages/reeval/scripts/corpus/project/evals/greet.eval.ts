import { evaluate, expect } from 'reeval'

evaluate('writes greet.js', async (t) => {
  const turn = await t.send('Write greet.js exporting greet(name).')
  await expect(turn).toHaveFile('greet.js', /Hello/)
  expect(await t.judge('Does greet.js export greet?')).toPass()
})

evaluate('fails its check', async (t) => {
  await t.send('Write greet.js that greets in French.')
  await expect(t.exec('grep -q Bonjour greet.js')).toSucceed()
})

evaluate('fails its judge', async (t) => {
  await t.send('Write greet.js.')
  expect(await t.judge('Is greet.js perfect?', { threshold: 0.95 })).toPass()
})

evaluate.skip('is skipped for now', async (t) => {
  await t.send('Write nothing.')
})

evaluate.todo('greets in Welsh')
