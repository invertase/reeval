import { evaluate, expect } from 'reeval'

const head = process.env.REEVAL_COMPARE_SIDE === 'head'

// Regressed: the house greeting passes on base and fails on head, so sign-off never runs there.
evaluate('greets in the house style', async (c) => {
  await c.send('Write greet.js that greets in our house style.')
  await expect.soft(c, 'writes greet.js').toHaveFile('greet.js')
  await expect(c.exec(`grep -q ${head ? 'Ahoy' : 'Hello'} greet.js`), 'house greeting').toSucceed()
  await expect(c.exec('grep -q "!" greet.js'), 'sign-off').toSucceed()
})

evaluate('writes greet.js', async (c) => {
  await c.send('Write greet.js.')
  await expect(c, 'writes greet.js').toHaveFile('greet.js')
})

// Fails the same way on both sides: informal greeting never runs on either, which is no change.
evaluate('greets in French', async (c) => {
  await c.send('Write greet.js that greets in French.')
  await expect(c.exec('grep -q Bonjour greet.js'), 'french greeting').toSucceed()
  await expect(c.exec('grep -q Salut greet.js'), 'informal greeting').toSucceed()
})

if (head) {
  evaluate('greets in Spanish', async (c) => {
    await c.send('Write greet.js that greets in Spanish.')
    await expect(c.exec('grep -q Hola greet.js'), 'spanish greeting').toSucceed()
  })
} else {
  evaluate('greets in German', async (c) => {
    await c.send('Write greet.js that greets in German.')
    await expect(c.exec('grep -q Hallo greet.js'), 'german greeting').toSucceed()
  })
}
