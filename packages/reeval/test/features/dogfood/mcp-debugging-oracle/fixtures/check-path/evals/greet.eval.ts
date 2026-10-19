import { evaluate, expect, group } from 'reeval'

const greetsAda = `node -e "import('./lib/greet.js').then((m) =>
  process.exit(m.greet('Ada') === 'Hello, Ada!' ? 0 : 1))"`

group('greeter', () => {
  evaluate('creates the greeter', async (c) => {
    const turn = await c.send(
      'Create lib/greet.js exporting greet(name), which returns "Hello, <name>!".',
    )
    await expect.soft(turn, 'greet.js exists').toHaveFile('src/greet.js', /export/)
    await expect.soft(c.exec(greetsAda), 'greets Ada').toSucceed()
  })
})
