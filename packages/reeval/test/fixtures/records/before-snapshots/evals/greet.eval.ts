import { evaluate, expect } from 'reeval'
import { fakeHarness } from 'reeval/harness'

evaluate('writes greet.js', async (c) => {
  const turn = await c.send('Write greet.js exporting greet(name).')
  await expect(turn).toHaveFile('greet.js', /Hello/)
  expect(await c.judge('Does greet.js export greet?')).toPass()
})

// A soft check that fails, then a judge that fails, in one attempt.
evaluate('fails its check and its judge', async (c) => {
  await c.send('Write greet.js that greets in French.')
  await expect.soft(c.exec('grep -q Bonjour greet.js')).toSucceed()
  expect(await c.judge('Is greet.js perfect?', { threshold: 0.95 })).toPass()
})

evaluate(
  'never starts',
  { harness: fakeHarness({ id: 'broken', failWith: 'the fake sandbox fell over' }) },
  async (c) => {
    await c.send('Write greet.js.')
  },
)

evaluate.skip('is skipped for now', async (c) => {
  await c.send('Write nothing.')
})

evaluate.todo('greets in Welsh')
