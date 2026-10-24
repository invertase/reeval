import { evaluate, expect, group } from 'reeval'
import { plain } from './environments.ts'

const greetsAda = `node -e "import('./greet.js').then((m) =>
  process.exit(m.greet('Ada') === 'Ahoy, Ada!' ? 0 : 1))"`

group('house style', { environment: plain }, () => {
  evaluate('greets in the house style', async (c) => {
    await c.send('Create greet.js exporting greet(name) in our house style.')
    await expect.soft(c.exec(greetsAda), 'greets Ada in the house style').toSucceed()
  })
})
