import { evaluate } from 'reeval'

evaluate('writes greet.js', async (c) => {
  await c.send('Write greet.js')
})
